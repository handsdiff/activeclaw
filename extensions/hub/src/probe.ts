import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import { resolveHubAccount } from "./accounts.js";
import type { CoreConfig, HubProbe } from "./types.js";

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

export async function probeHub(
  cfg: CoreConfig,
  opts?: { accountId?: string; timeoutMs?: number },
): Promise<HubProbe> {
  const account = resolveHubAccount({ cfg, accountId: opts?.accountId });
  const base: HubProbe = {
    ok: false,
    url: account.url,
    agentId: account.agentId,
  };

  if (!account.configured) {
    return {
      ...base,
      error: "missing url, agentId, or secret",
    };
  }

  const started = Date.now();
  const timeoutMs = opts?.timeoutMs ?? 8000;
  try {
    const pollUrl = `${account.url}/agents/${encodeURIComponent(account.agentId)}/messages/poll?secret=${encodeURIComponent(account.secret)}&timeout=1`;
    const { response, release } = await fetchWithSsrFGuard({
      url: pollUrl,
      timeoutMs,
      init: {
        headers: { Accept: "application/json" },
      },
    });

    try {
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          ...base,
          error: `HTTP ${response.status}: ${body}`,
        };
      }

      const elapsed = Date.now() - started;
      return {
        ...base,
        ok: true,
        latencyMs: elapsed,
      };
    } finally {
      await release();
    }
  } catch (err) {
    return {
      ...base,
      error: formatError(err),
    };
  }
}
