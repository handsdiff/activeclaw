import { createLoggerBackedRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/compat";
import { resolveHubAccount } from "./accounts.js";
import { handleHubInbound } from "./inbound.js";
import { getHubRuntime } from "./runtime.js";
import { sendMessageHub } from "./send.js";
import type { CoreConfig, HubInboundMessage } from "./types.js";
import { connectHubWebSocket } from "./ws.js";

export type HubMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export async function monitorHubProvider(opts: HubMonitorOptions): Promise<{ stop: () => void }> {
  const core = getHubRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolveHubAccount({ cfg, accountId: opts.accountId });

  const runtime: RuntimeEnv =
    opts.runtime ??
    createLoggerBackedRuntime({
      logger: core.logging.getChildLogger(),
      exitError: () => new Error("Runtime exit not available"),
    });

  if (!account.configured) {
    throw new Error(
      `Hub is not configured for account "${account.accountId}" (need url, agentId, and secret in channels.hub).`,
    );
  }

  const logger = core.logging.getChildLogger({
    channel: "hub",
    accountId: account.accountId,
  });

  const ac = new AbortController();
  const combinedSignal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, ac.signal])
    : ac.signal;

  console.error("[HUB-MONITOR-DEBUG] calling connectHubWebSocket");
  // Block until abort signal — gateway expects startAccount to stay alive
  const wsPromise = connectHubWebSocket({
    url: account.url,
    agentId: account.agentId,
    secret: account.secret,
    abortSignal: combinedSignal,
    onConnected: () => {
      logger.info(`[${account.accountId}] Hub WebSocket connected`);
    },
    onMessages: async (messages: HubInboundMessage[]) => {
      for (const message of messages) {
        const now = Date.now();
        const rawTs = message.timestamp as unknown;
        const parsedTs =
          typeof rawTs === "number"
            ? rawTs
            : typeof rawTs === "string"
              ? new Date(rawTs).getTime() || now
              : now;

        const msg: HubInboundMessage = {
          messageId: message.messageId || `hub-${crypto.randomUUID()}`,
          from: message.from,
          text: message.text,
          timestamp: parsedTs,
        };

        core.channel.activity.record({
          channel: "hub",
          accountId: account.accountId,
          direction: "inbound",
          at: msg.timestamp,
        });

        await handleHubInbound({
          message: msg,
          account,
          config: cfg,
          runtime,
          sendReply: async (to: string, text: string) => {
            await sendMessageHub(to, text, { accountId: account.accountId });
            opts.statusSink?.({ lastOutboundAt: Date.now() });
          },
          statusSink: opts.statusSink,
        });
      }
    },
    onError: (error) => {
      logger.error(`[${account.accountId}] Hub WebSocket error: ${error.message}`);
    },
  });

  logger.info(
    `[${account.accountId}] started Hub provider (${account.url}, agent=${account.agentId})`,
  );

  // Return stop handle but keep the promise chain alive
  // Gateway expects startAccount to stay running — awaiting wsPromise blocks until abort
  const stopFn = () => {
    ac.abort();
  };
  await wsPromise;
  return { stop: stopFn };
}
