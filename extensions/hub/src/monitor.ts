import { createLoggerBackedRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/compat";
import { resolveHubAccount } from "./accounts.js";
import { handleHubInbound } from "./inbound.js";
import { pollHubMessages } from "./poll.js";
import { getHubRuntime } from "./runtime.js";
import { markMessageReadHub, sendMessageHub } from "./send.js";
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
  const pollTimeoutSec =
    typeof account.config.pollTimeoutSec === "number" && account.config.pollTimeoutSec > 0
      ? account.config.pollTimeoutSec
      : 20;
  const POLL_FALLBACK_WINDOW_MS = 60_000;
  const RECEIPT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const inboundReceipts = new Map<
    string,
    { status: "processing" | "processed" | "acked"; processedAt: number }
  >();

  const pruneReceiptCache = (now = Date.now()) => {
    for (const [messageId, state] of inboundReceipts.entries()) {
      if (now - state.processedAt > RECEIPT_CACHE_TTL_MS) {
        inboundReceipts.delete(messageId);
      }
    }
  };

  async function processInboundMessage(message: HubInboundMessage) {
    const normalizedMessageId =
      typeof message.messageId === "string" ? message.messageId.trim() : "";
    if (!normalizedMessageId) {
      logger.error(
        `[${account.accountId}] Hub inbound message missing stable messageId; refusing to process without ackable identity`,
      );
      return;
    }
    const now = Date.now();
    const rawTs = message.timestamp as unknown;
    const parsedTs =
      typeof rawTs === "number"
        ? rawTs
        : typeof rawTs === "string"
          ? new Date(rawTs).getTime() || now
          : now;

    const msg: HubInboundMessage = {
      messageId: normalizedMessageId,
      from: message.from,
      text: message.text,
      timestamp: parsedTs,
    };

    pruneReceiptCache();
    const existing = inboundReceipts.get(msg.messageId);

    if (existing?.status === "acked") {
      return;
    }

    if (existing?.status === "processing") {
      return;
    }

    if (!existing) {
      inboundReceipts.set(msg.messageId, {
        status: "processing",
        processedAt: Date.now(),
      });

      core.channel.activity.record({
        channel: "hub",
        accountId: account.accountId,
        direction: "inbound",
        at: msg.timestamp,
      });

      try {
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
      } catch (error) {
        logger.error(
          `[${account.accountId}] Hub inbound processing failed for ${msg.messageId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        inboundReceipts.delete(msg.messageId);
        return;
      }

      inboundReceipts.set(msg.messageId, {
        status: "processed",
        processedAt: Date.now(),
      });
    }

    const receiptState = inboundReceipts.get(msg.messageId);
    if (!receiptState || receiptState.status === "processing") {
      return;
    }
    if (receiptState?.status === "acked") {
      return;
    }

    try {
      await markMessageReadHub(msg.messageId, { accountId: account.accountId });
      inboundReceipts.set(msg.messageId, {
        status: "acked",
        processedAt: receiptState?.processedAt ?? Date.now(),
      });
    } catch (error) {
      logger.warn(
        `[${account.accountId}] Hub ack failed for ${msg.messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function runPollFallback(reason: string) {
    logger.warn(`[${account.accountId}] Hub WebSocket fallback to poll: ${reason}`);
    await pollHubMessages({
      url: account.url,
      agentId: account.agentId,
      secret: account.secret,
      pollTimeoutSec,
      maxRuntimeMs: POLL_FALLBACK_WINDOW_MS,
      abortSignal: combinedSignal,
      onMessages: async (messages: HubInboundMessage[]) => {
        for (const message of messages) {
          await processInboundMessage(message);
        }
      },
      onError: (error) => {
        logger.error(`[${account.accountId}] Hub poll error: ${error.message}`);
      },
    });
  }

  const ac = new AbortController();
  const combinedSignal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, ac.signal])
    : ac.signal;

  logger.info(
    `[${account.accountId}] started Hub provider (${account.url}, agent=${account.agentId})`,
  );

  const stopFn = () => {
    ac.abort();
  };

  while (!combinedSignal.aborted) {
    await connectHubWebSocket({
      url: account.url,
      agentId: account.agentId,
      secret: account.secret,
      abortSignal: combinedSignal,
      onConnected: () => {
        logger.info(`[${account.accountId}] Hub WebSocket connected`);
      },
      onMessages: async (messages: HubInboundMessage[]) => {
        for (const message of messages) {
          await processInboundMessage(message);
        }
      },
      onError: (error) => {
        logger.error(`[${account.accountId}] Hub WebSocket error: ${error.message}`);
      },
      fallbackAfterFailures: 3,
      onFallbackToPoll: runPollFallback,
    });

    if (!combinedSignal.aborted) {
      logger.info(`[${account.accountId}] retrying Hub WebSocket after poll fallback window`);
    }
  }

  return { stop: stopFn };
}
