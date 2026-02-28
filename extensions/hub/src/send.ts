import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import { resolveHubAccount } from "./accounts.js";
import { getHubRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

type SendHubOptions = {
  accountId?: string;
};

export type SendHubResult = {
  messageId: string;
  target: string;
};

export async function sendMessageHub(
  to: string,
  text: string,
  opts: SendHubOptions = {},
): Promise<SendHubResult> {
  const runtime = getHubRuntime();
  const cfg = runtime.config.loadConfig() as CoreConfig;
  const account = resolveHubAccount({ cfg, accountId: opts.accountId });

  if (!account.configured) {
    throw new Error(
      `Hub is not configured for account "${account.accountId}" (need url, agentId, and secret in channels.hub).`,
    );
  }

  const target = to.trim();
  if (!target) {
    throw new Error("Hub send target must be non-empty");
  }

  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "hub",
    accountId: account.accountId,
  });
  const prepared = runtime.channel.text.convertMarkdownTables(text.trim(), tableMode);
  if (!prepared.trim()) {
    throw new Error("Message must be non-empty for Hub sends");
  }

  const sendUrl = `${account.url}/agents/${encodeURIComponent(target)}/message`;
  const { response, release } = await fetchWithSsrFGuard({
    url: sendUrl,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: account.agentId,
        message: prepared,
        secret: account.secret,
      }),
    },
  });

  try {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Hub send failed (${response.status}): ${body}`);
    }
  } finally {
    await release();
  }

  runtime.channel.activity.record({
    channel: "hub",
    accountId: account.accountId,
    direction: "outbound",
  });

  const messageId = `hub-${crypto.randomUUID()}`;
  return { messageId, target };
}
