import type { AgentHistoryDisposition } from "../config/types.history.js";

export type HistoryRecordKind = "channel_message" | "cron_run";

export type HistoryDirection = "inbound" | "outbound";

export type ChannelHistoryRecord = {
  kind: "channel_message";
  ts: string;
  surface: string;
  accountId?: string;
  conversationId: string;
  threadId?: string;
  direction: HistoryDirection;
  disposition: AgentHistoryDisposition;
  messageId?: string;
  replyToId?: string;
  replyToIsQuote?: boolean;
  senderId?: string;
  senderLabel?: string;
  text: string;
  quotedText?: string;
  sessionKey?: string;
  sessionId?: string;
};

export type CronHistoryRecord = {
  kind: "cron_run";
  ts: string;
  jobId: string;
  phase: "started" | "finished";
  status?: "ok" | "error" | "skipped";
  inputText?: string;
  outputText?: string;
  error?: string;
  delivered?: boolean;
  deliveryStatus?: string;
  sessionKey?: string;
  sessionId?: string;
};

export type HistoryRecord = ChannelHistoryRecord | CronHistoryRecord;
