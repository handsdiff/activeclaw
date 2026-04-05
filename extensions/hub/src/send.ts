import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/compat";
import { resolveHubAccount } from "./accounts.js";
import { getHubRuntime } from "./runtime.js";
import { normalizeHubTarget } from "./targets.js";
import type { CoreConfig } from "./types.js";

type SendHubOptions = {
  accountId?: string;
};

export type SendHubResult = {
  messageId: string;
  target: string;
};

function buildTrustedHubFetchParams(url: string, init: RequestInit, auditContext: string) {
  const hostname = new URL(url).hostname;
  return {
    url,
    init,
    mode: "trusted_env_proxy" as const,
    policy: {
      allowedHostnames: [hostname],
    },
    auditContext,
  };
}

function resolveConfiguredHubAccount(opts: SendHubOptions = {}) {
  const runtime = getHubRuntime();
  const cfg = runtime.config.loadConfig() as CoreConfig;
  const account = resolveHubAccount({ cfg, accountId: opts.accountId });

  if (!account.configured) {
    throw new Error(
      `Hub is not configured for account "${account.accountId}" (need url, agentId, and secret in channels.hub).`,
    );
  }

  return { runtime, cfg, account };
}

export async function sendMessageHub(
  to: string,
  text: string,
  opts: SendHubOptions = {},
): Promise<SendHubResult> {
  const { runtime, cfg, account } = resolveConfiguredHubAccount(opts);

  const target = normalizeHubTarget(to);
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
  const { response, release } = await fetchWithSsrFGuard(
    buildTrustedHubFetchParams(
      sendUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: account.agentId,
          message: prepared,
          secret: account.secret,
        }),
      },
      "hub-send",
    ),
  );

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

export async function markMessageReadHub(
  messageId: string,
  opts: SendHubOptions = {},
): Promise<void> {
  if (!messageId.trim()) {
    throw new Error("Hub read ack requires a non-empty messageId");
  }

  const { account } = resolveConfiguredHubAccount(opts);
  const ackUrl = `${account.url}/agents/${encodeURIComponent(account.agentId)}/messages/${encodeURIComponent(messageId)}/read`;
  const { response, release } = await fetchWithSsrFGuard(
    buildTrustedHubFetchParams(
      ackUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: account.secret }),
      },
      "hub-read-ack",
    ),
  );

  try {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Hub read ack failed (${response.status}): ${body}`);
    }
  } finally {
    await release();
  }
}
