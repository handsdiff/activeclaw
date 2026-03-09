import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { AgentHistoryDisposition } from "../config/types.history.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentHistoryConfig } from "./config.js";
import { appendChannelHistoryRecord, appendCronHistoryRecord } from "./writer.js";

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveContextSurface(ctx: FinalizedMsgContext): string {
  return (
    trimOptionalString(ctx.Surface)?.toLowerCase() ??
    trimOptionalString(ctx.Provider)?.toLowerCase() ??
    "unknown"
  );
}

function resolveContextConversationKey(ctx: FinalizedMsgContext): string | undefined {
  return (
    trimOptionalString(ctx.OriginatingTo) ??
    trimOptionalString(ctx.To) ??
    trimOptionalString(ctx.From) ??
    trimOptionalString(ctx.ConversationLabel)
  );
}

function resolveContextBody(ctx: FinalizedMsgContext): string | undefined {
  return (
    trimOptionalString(ctx.BodyForCommands) ??
    trimOptionalString(ctx.CommandBody) ??
    trimOptionalString(ctx.RawBody) ??
    trimOptionalString(ctx.BodyForAgent) ??
    trimOptionalString(ctx.Body)
  );
}

function resolveContextMessageId(ctx: FinalizedMsgContext): string | undefined {
  return (
    trimOptionalString(ctx.MessageSidFull) ??
    trimOptionalString(ctx.MessageSid) ??
    trimOptionalString(ctx.MessageSidFirst) ??
    trimOptionalString(ctx.MessageSidLast)
  );
}

export async function emitInboundHistoryFromContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  ctx: FinalizedMsgContext;
  disposition?: AgentHistoryDisposition;
}) {
  const history = resolveAgentHistoryConfig(params.cfg, params.agentId);
  const text = resolveContextBody(params.ctx);
  const conversationKey = resolveContextConversationKey(params.ctx);
  if (!text || !conversationKey) {
    return { written: false } as const;
  }
  return await emitInboundHistory({
    cfg: params.cfg,
    agentId: params.agentId,
    surface: resolveContextSurface(params.ctx),
    conversationKey,
    disposition: params.disposition ?? "processed",
    text,
    ts: params.ctx.Timestamp,
    accountId: trimOptionalString(params.ctx.AccountId),
    threadId: trimOptionalString(params.ctx.MessageThreadId),
    messageId: resolveContextMessageId(params.ctx),
    replyToId:
      trimOptionalString(params.ctx.ReplyToIdFull) ?? trimOptionalString(params.ctx.ReplyToId),
    replyToIsQuote: params.ctx.ReplyToIsQuote,
    senderId: trimOptionalString(params.ctx.SenderId),
    senderLabel:
      trimOptionalString(params.ctx.SenderName) ??
      trimOptionalString(params.ctx.SenderUsername) ??
      trimOptionalString(params.ctx.SenderTag),
    quotedText: history.channel.includeQuotedContext
      ? trimOptionalString(params.ctx.ReplyToBody)
      : undefined,
    sessionKey: trimOptionalString(params.ctx.SessionKey),
  });
}

export async function emitInboundHistory(params: {
  cfg: OpenClawConfig;
  agentId: string;
  surface: string;
  conversationKey: string;
  disposition: AgentHistoryDisposition;
  text: string;
  ts?: string | number | Date;
  accountId?: string;
  threadId?: string;
  messageId?: string;
  replyToId?: string;
  replyToIsQuote?: boolean;
  senderId?: string;
  senderLabel?: string;
  quotedText?: string;
  sessionKey?: string;
  sessionId?: string;
}) {
  const timestamp = new Date(params.ts ?? Date.now()).toISOString();
  return await appendChannelHistoryRecord({
    cfg: params.cfg,
    agentId: params.agentId,
    surface: params.surface,
    conversationKey: params.conversationKey,
    record: {
      kind: "channel_message",
      ts: timestamp,
      surface: params.surface,
      accountId: params.accountId,
      conversationId: params.conversationKey,
      threadId: params.threadId,
      direction: "inbound",
      disposition: params.disposition,
      messageId: params.messageId,
      replyToId: params.replyToId,
      replyToIsQuote: params.replyToIsQuote,
      senderId: params.senderId,
      senderLabel: params.senderLabel,
      text: params.text,
      quotedText: params.quotedText,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    },
  });
}

export async function emitOutboundHistory(params: {
  cfg: OpenClawConfig;
  agentId: string;
  surface: string;
  conversationKey: string;
  text: string;
  ts?: string | number | Date;
  accountId?: string;
  threadId?: string;
  messageId?: string;
  replyToId?: string;
  senderLabel?: string;
  sessionKey?: string;
  sessionId?: string;
}) {
  const timestamp = new Date(params.ts ?? Date.now()).toISOString();
  return await appendChannelHistoryRecord({
    cfg: params.cfg,
    agentId: params.agentId,
    surface: params.surface,
    conversationKey: params.conversationKey,
    record: {
      kind: "channel_message",
      ts: timestamp,
      surface: params.surface,
      accountId: params.accountId,
      conversationId: params.conversationKey,
      threadId: params.threadId,
      direction: "outbound",
      disposition: "processed",
      messageId: params.messageId,
      replyToId: params.replyToId,
      senderLabel: params.senderLabel,
      text: params.text,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    },
  });
}

export async function emitCronHistory(params: {
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  phase: "started" | "finished";
  ts?: string | number | Date;
  status?: "ok" | "error" | "skipped";
  inputText?: string;
  outputText?: string;
  error?: string;
  delivered?: boolean;
  deliveryStatus?: string;
  sessionKey?: string;
  sessionId?: string;
}) {
  const timestamp = new Date(params.ts ?? Date.now()).toISOString();
  return await appendCronHistoryRecord({
    cfg: params.cfg,
    agentId: params.agentId,
    jobId: params.jobId,
    record: {
      kind: "cron_run",
      ts: timestamp,
      jobId: params.jobId,
      phase: params.phase,
      status: params.status,
      inputText: params.inputText,
      outputText: params.outputText,
      error: params.error,
      delivered: params.delivered,
      deliveryStatus: params.deliveryStatus,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    },
  });
}
