import { setTimeout } from "node:timers/promises";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/compat";
import type { HubInboundMessage } from "./types.js";

function buildTrustedHubFetchParams(url: string, signal?: AbortSignal) {
  const hostname = new URL(url).hostname;
  // Hub base URLs are operator-configured trusted endpoints. Allow the exact
  // configured hostname so polling can survive split-horizon / reverse-proxy
  // deployments without disabling SSRF protections for arbitrary hosts.
  return {
    url,
    signal,
    init: {
      headers: { Accept: "application/json" },
    },
    mode: "trusted_env_proxy" as const,
    policy: {
      allowedHostnames: [hostname],
    },
    auditContext: "hub-poll",
  };
}

export type PollHubOptions = {
  url: string;
  agentId: string;
  secret: string;
  pollTimeoutSec: number;
  maxRuntimeMs?: number;
  abortSignal?: AbortSignal;
  onMessages: (messages: HubInboundMessage[]) => void | Promise<void>;
  onError?: (error: Error) => void;
};

function computeBackoff(attempt: number): number {
  const initialMs = 1000;
  const maxMs = 60_000;
  const factor = 2;
  const jitter = 0.3;
  const base = Math.min(initialMs * factor ** attempt, maxMs);
  const offset = base * jitter * (Math.random() * 2 - 1);
  return Math.max(initialMs, Math.round(base + offset));
}

export async function pollHubMessages(opts: PollHubOptions): Promise<void> {
  const { url, agentId, secret, pollTimeoutSec, maxRuntimeMs, abortSignal, onMessages, onError } =
    opts;
  let attempt = 0;
  const startedAt = Date.now();
  const remainingBudgetMs = () =>
    typeof maxRuntimeMs === "number" ? maxRuntimeMs - (Date.now() - startedAt) : null;

  while (!abortSignal?.aborted) {
    const remainingMs = remainingBudgetMs();
    if (remainingMs !== null && remainingMs <= 0) {
      break;
    }
    try {
      const boundedTimeoutSec =
        remainingMs === null
          ? pollTimeoutSec
          : Math.max(1, Math.min(pollTimeoutSec, Math.ceil(remainingMs / 1000)));
      const pollUrl = `${url}/agents/${encodeURIComponent(agentId)}/messages/poll?secret=${encodeURIComponent(secret)}&timeout=${boundedTimeoutSec}`;
      const { response, release } = await fetchWithSsrFGuard(
        buildTrustedHubFetchParams(pollUrl, abortSignal),
      );

      try {
        if (!response.ok) {
          throw new Error(`Hub poll returned ${response.status}: ${await response.text()}`);
        }

        const body = await response.json();
        const messages: HubInboundMessage[] = Array.isArray(body) ? body : (body.messages ?? []);

        if (messages.length > 0) {
          await onMessages(messages);
        }
      } finally {
        await release();
      }

      // Reset backoff on success, but always wait a minimum interval
      // to prevent tight-looping if server returns immediately.
      attempt = 0;
      const MIN_POLL_INTERVAL_MS = 5_000;
      const postRequestBudgetMs = remainingBudgetMs();
      if (postRequestBudgetMs !== null && postRequestBudgetMs <= 0) {
        break;
      }
      const sleepMs =
        postRequestBudgetMs === null
          ? MIN_POLL_INTERVAL_MS
          : Math.min(MIN_POLL_INTERVAL_MS, postRequestBudgetMs);
      try {
        await setTimeout(sleepMs, undefined, { signal: abortSignal });
      } catch {
        break;
      }
      const afterSleepBudgetMs = remainingBudgetMs();
      if (afterSleepBudgetMs !== null && afterSleepBudgetMs <= 0) {
        break;
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        break;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);

      const backoffBudgetMs = remainingBudgetMs();
      if (backoffBudgetMs !== null && backoffBudgetMs <= 0) {
        break;
      }
      const delay =
        backoffBudgetMs === null
          ? computeBackoff(attempt)
          : Math.min(computeBackoff(attempt), backoffBudgetMs);
      attempt++;
      try {
        await setTimeout(delay, undefined, { signal: abortSignal });
      } catch {
        // Abort signal fired during sleep — exit loop.
        break;
      }
    }
  }
}
