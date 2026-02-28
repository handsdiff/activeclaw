import { setTimeout } from "node:timers/promises";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import type { HubInboundMessage } from "./types.js";

export type PollHubOptions = {
  url: string;
  agentId: string;
  secret: string;
  pollTimeoutSec: number;
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
  const { url, agentId, secret, pollTimeoutSec, abortSignal, onMessages, onError } = opts;
  let attempt = 0;

  while (!abortSignal?.aborted) {
    try {
      const pollUrl = `${url}/agents/${encodeURIComponent(agentId)}/messages/poll?secret=${encodeURIComponent(secret)}&timeout=${pollTimeoutSec}`;
      const { response, release } = await fetchWithSsrFGuard({
        url: pollUrl,
        signal: abortSignal,
        init: {
          headers: { Accept: "application/json" },
        },
      });

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

      // Reset backoff on success.
      attempt = 0;
    } catch (err) {
      if (abortSignal?.aborted) {
        break;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);

      const delay = computeBackoff(attempt);
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
