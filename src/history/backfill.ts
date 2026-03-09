import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  loadSessionStore,
  resolveDefaultSessionStorePath,
  resolveSessionTranscriptsDirForAgent,
  type SessionEntry,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  readCronRunLogEntries,
  resolveCronRunLogPath,
  type CronRunLogEntry,
} from "../cron/run-log.js";
import { resolveCronStorePath } from "../cron/store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listHistoryFilesForAgent } from "../memory/history-files.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { parseInlineDirectives } from "../utils/directive-tags.js";
import type { ChannelHistoryRecord, CronHistoryRecord, HistoryRecord } from "./types.js";
import { appendChannelHistoryRecord, appendCronHistoryRecord } from "./writer.js";

const log = createSubsystemLogger("history/backfill");

type TranscriptMessage = {
  id?: string;
  ts: string;
  role: "user" | "assistant";
  text: string;
  provider?: string;
  model?: string;
};

type TranscriptEnvelope = {
  text: string;
  conversationInfo?: {
    messageId?: string;
    replyToId?: string;
    senderId?: string;
    senderLabel?: string;
    conversationLabel?: string;
    groupSubject?: string;
    isGroupChat?: boolean;
  };
  sender?: {
    id?: string;
    label?: string;
    name?: string;
    username?: string;
  };
  replyContext?: {
    senderLabel?: string;
    body?: string;
  };
};

type ChannelRoute = {
  kind: "channel";
  surface: string;
  conversationKey: string;
  accountId?: string;
  threadId?: string;
  sessionKey?: string;
};

type CronRoute = {
  kind: "cron";
  jobId: string;
  sessionKey?: string;
};

type TranscriptRoute = ChannelRoute | CronRoute;

type SessionIndexEntry = {
  sessionKey: string;
  entry: SessionEntry;
};

type HistoryBackfillOptions = {
  cfg: OpenClawConfig;
  agentId: string;
  includeHubJson?: boolean;
};

export type HistoryBackfillSummary = {
  agentId: string;
  existingHistoryRecords: number;
  sessionFilesScanned: number;
  sessionFilesImported: number;
  hubJsonFilesScanned: number;
  hubJsonFilesImported: number;
  channelRecordsWritten: number;
  cronRecordsWritten: number;
  duplicateRecordsSkipped: number;
  filteredRecordsSkipped: number;
};

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeTimestampForKey(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return ts.trim();
  }
  return date.toISOString().slice(0, 19);
}

function normalizeTextForKey(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildHistoryDedupKeys(record: HistoryRecord): string[] {
  if (record.kind === "channel_message") {
    const keys: string[] = [];
    const prefix = [
      "channel",
      record.surface.trim().toLowerCase(),
      record.conversationId.trim().toLowerCase(),
      record.direction,
    ].join("|");
    if (record.messageId) {
      keys.push(`${prefix}|message:${record.messageId.trim().toLowerCase()}`);
    }
    const fallbackBase = [
      record.sessionId ?? "",
      normalizeTimestampForKey(record.ts),
      record.direction,
      normalizeTextForKey(record.text),
      normalizeTextForKey(record.quotedText),
    ].join("|");
    keys.push(`${prefix}|fallback:${hashKey(fallbackBase)}`);
    const contentBase = [
      normalizeTimestampForKey(record.ts),
      record.direction,
      normalizeTextForKey(record.text),
      normalizeTextForKey(record.quotedText),
    ].join("|");
    keys.push(`${prefix}|content:${hashKey(contentBase)}`);
    return keys;
  }

  const prefix = ["cron", record.jobId.trim().toLowerCase(), record.phase].join("|");
  const primaryBase = [normalizeTimestampForKey(record.ts), record.sessionId ?? ""].join("|");
  const contentBase = [
    normalizeTimestampForKey(record.ts),
    record.sessionId ?? "",
    normalizeTextForKey(record.inputText),
    normalizeTextForKey(record.outputText),
    normalizeTextForKey(record.error),
    record.status ?? "",
    record.deliveryStatus ?? "",
  ].join("|");
  return [`${prefix}|primary:${hashKey(primaryBase)}`, `${prefix}|content:${hashKey(contentBase)}`];
}

function addDedupKeys(target: Set<string>, record: HistoryRecord): void {
  for (const key of buildHistoryDedupKeys(record)) {
    target.add(key);
  }
}

function hasAnyDedupKey(target: Set<string>, record: HistoryRecord): boolean {
  return buildHistoryDedupKeys(record).some((key) => target.has(key));
}

function isArchivedSessionTranscriptFileName(fileName: string): boolean {
  return fileName.includes(".jsonl.archived.");
}

function isImportableSessionTranscriptFileName(fileName: string): boolean {
  return (
    isPrimarySessionTranscriptFileName(fileName) ||
    isSessionArchiveArtifactName(fileName) ||
    isArchivedSessionTranscriptFileName(fileName)
  );
}

function parseSessionIdFromTranscriptFileName(fileName: string): string | null {
  const marker = ".jsonl";
  const index = fileName.indexOf(marker);
  if (index <= 0) {
    return null;
  }
  const sessionId = fileName.slice(0, index).trim();
  return sessionId || null;
}

async function listImportableSessionTranscriptPaths(agentId: string): Promise<string[]> {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && isImportableSessionTranscriptFileName(entry.name))
    .map((entry) => path.join(sessionsDir, entry.name))
    .toSorted((left, right) => left.localeCompare(right));
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    parts.push(record.text);
  }
  return parts.join("\n\n");
}

async function readTranscriptMessages(absPath: string): Promise<TranscriptMessage[]> {
  const raw = await fs.readFile(absPath, "utf-8");
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { type?: unknown }).type !== "message"
    ) {
      continue;
    }
    const record = parsed as {
      id?: unknown;
      timestamp?: unknown;
      message?: {
        role?: unknown;
        content?: unknown;
        provider?: unknown;
        model?: unknown;
      };
    };
    const role = record.message?.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractMessageText(record.message?.content).trim();
    if (!text) {
      continue;
    }
    messages.push({
      id: trimOptionalString(record.id),
      ts: trimOptionalString(record.timestamp) ?? new Date().toISOString(),
      role,
      text,
      provider: trimOptionalString(record.message?.provider),
      model: trimOptionalString(record.message?.model),
    });
  }
  return messages;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLeadingJsonSection(
  text: string,
  label: string,
): { nextText: string; data?: unknown } {
  const sectionRe = new RegExp(
    `${escapeRegExp(label)}\\s*\\\`\\\`\\\`json\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`\\s*`,
    "i",
  );
  const match = sectionRe.exec(text);
  if (!match) {
    return { nextText: text };
  }
  let data: unknown;
  try {
    data = JSON.parse(match[1] ?? "");
  } catch {
    data = undefined;
  }
  return {
    nextText: `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim(),
    data,
  };
}

function parseTranscriptEnvelope(text: string): TranscriptEnvelope {
  let remaining = text.replace(/^Queued\s+#\d+\s*/i, "").trim();
  const conversationSection = extractLeadingJsonSection(
    remaining,
    "Conversation info (untrusted metadata):",
  );
  remaining = conversationSection.nextText;
  const senderSection = extractLeadingJsonSection(remaining, "Sender (untrusted metadata):");
  remaining = senderSection.nextText;
  const replySection = extractLeadingJsonSection(
    remaining,
    "Replied message (untrusted, for context):",
  );
  remaining = replySection.nextText;

  const conversationInfoRecord =
    conversationSection.data && typeof conversationSection.data === "object"
      ? (conversationSection.data as Record<string, unknown>)
      : undefined;
  const senderRecord =
    senderSection.data && typeof senderSection.data === "object"
      ? (senderSection.data as Record<string, unknown>)
      : undefined;
  const replyRecord =
    replySection.data && typeof replySection.data === "object"
      ? (replySection.data as Record<string, unknown>)
      : undefined;

  return {
    text: remaining.trim(),
    conversationInfo: conversationInfoRecord
      ? {
          messageId: trimOptionalString(conversationInfoRecord.message_id),
          replyToId: trimOptionalString(conversationInfoRecord.reply_to_id),
          senderId: trimOptionalString(conversationInfoRecord.sender_id),
          senderLabel: trimOptionalString(conversationInfoRecord.sender),
          conversationLabel: trimOptionalString(conversationInfoRecord.conversation_label),
          groupSubject: trimOptionalString(conversationInfoRecord.group_subject),
          isGroupChat: conversationInfoRecord.is_group_chat === true,
        }
      : undefined,
    sender: senderRecord
      ? {
          id: trimOptionalString(senderRecord.id),
          label: trimOptionalString(senderRecord.label),
          name: trimOptionalString(senderRecord.name),
          username: trimOptionalString(senderRecord.username),
        }
      : undefined,
    replyContext: replyRecord
      ? {
          senderLabel: trimOptionalString(replyRecord.sender_label),
          body: trimOptionalString(replyRecord.body),
        }
      : undefined,
  };
}

function normalizeLower(value: string | undefined): string | undefined {
  const trimmed = trimOptionalString(value);
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function extractConversationIdFromLabel(label: string | undefined): string | undefined {
  const trimmed = trimOptionalString(label);
  if (!trimmed) {
    return undefined;
  }
  const match = /(?:^|\s)id:([^\s]+)\s*$/i.exec(trimmed);
  return trimOptionalString(match?.[1]);
}

function isNumericConversationId(value: string | undefined): boolean {
  return Boolean(value && /^-?\d+$/.test(value));
}

function inferChannelRouteFromTranscript(params: {
  sessionId: string;
  envelope: TranscriptEnvelope | undefined;
  knownHubPeers: Set<string>;
}): ChannelRoute {
  const senderId = trimOptionalString(
    params.envelope?.sender?.id ?? params.envelope?.conversationInfo?.senderId,
  );
  const conversationIdFromLabel = extractConversationIdFromLabel(
    params.envelope?.conversationInfo?.conversationLabel,
  );
  if (isNumericConversationId(conversationIdFromLabel)) {
    return {
      kind: "channel",
      surface: "telegram",
      conversationKey: `telegram:${conversationIdFromLabel}`,
    };
  }
  if (isNumericConversationId(senderId)) {
    return {
      kind: "channel",
      surface: "telegram",
      conversationKey: `telegram:${senderId}`,
    };
  }
  const normalizedSender = normalizeLower(senderId);
  if (normalizedSender && params.knownHubPeers.has(normalizedSender)) {
    return {
      kind: "channel",
      surface: "hub",
      conversationKey: `hub:${senderId}`,
    };
  }
  return {
    kind: "channel",
    surface: "session",
    conversationKey: `session:${params.sessionId}`,
  };
}

function extractCronJobIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const rest = parseAgentSessionKey(sessionKey)?.rest ?? "";
  const match = /^cron:([^:]+)(?::run:[^:]+)?$/i.exec(rest);
  return trimOptionalString(match?.[1]);
}

function extractCronJobIdFromPrompt(text: string): string | undefined {
  const match = /^\[cron:([^\]\s]+)(?: [^\]]*)?\]/i.exec(text.trim());
  return trimOptionalString(match?.[1]);
}

function stripCronPromptPrefix(text: string): string {
  return text.replace(/^\[cron:[^\]\n]+\]\s*/i, "").trim();
}

function deriveChannelRouteFromSessionIndex(params: {
  sessionId: string;
  sessionKey: string;
  entry: SessionEntry;
  knownHubPeers: Set<string>;
}): TranscriptRoute {
  const cronJobId = extractCronJobIdFromSessionKey(params.sessionKey);
  if (cronJobId) {
    return { kind: "cron", jobId: cronJobId, sessionKey: params.sessionKey };
  }

  const surface =
    normalizeLower(params.entry.origin?.surface) ??
    normalizeLower(params.entry.origin?.provider) ??
    normalizeLower(params.entry.lastChannel) ??
    normalizeLower(params.entry.channel) ??
    "session";
  const conversationKey =
    trimOptionalString(params.entry.origin?.to) ??
    trimOptionalString(params.entry.lastTo) ??
    inferChannelRouteFromTranscript({
      sessionId: params.sessionId,
      envelope: undefined,
      knownHubPeers: params.knownHubPeers,
    }).conversationKey;
  return {
    kind: "channel",
    surface,
    conversationKey,
    accountId:
      trimOptionalString(params.entry.origin?.accountId) ??
      trimOptionalString(params.entry.lastAccountId) ??
      trimOptionalString(params.entry.deliveryContext?.accountId),
    threadId:
      trimOptionalString(
        typeof params.entry.origin?.threadId === "number"
          ? String(params.entry.origin.threadId)
          : params.entry.origin?.threadId,
      ) ??
      trimOptionalString(
        typeof params.entry.lastThreadId === "number"
          ? String(params.entry.lastThreadId)
          : params.entry.lastThreadId,
      ) ??
      trimOptionalString(
        typeof params.entry.deliveryContext?.threadId === "number"
          ? String(params.entry.deliveryContext.threadId)
          : params.entry.deliveryContext?.threadId,
      ),
    sessionKey: params.sessionKey,
  };
}

async function loadExistingHistoryDedup(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<{ dedupe: Set<string>; existingRecords: number }> {
  const dedupe = new Set<string>();
  let existingRecords = 0;
  for (const filePath of await listHistoryFilesForAgent(params.cfg, params.agentId)) {
    const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as HistoryRecord;
        addDedupKeys(dedupe, record);
        existingRecords += 1;
      } catch {
        continue;
      }
    }
  }
  return { dedupe, existingRecords };
}

function buildSessionIndex(agentId: string): Map<string, SessionIndexEntry> {
  const store = loadSessionStore(resolveDefaultSessionStorePath(agentId), { skipCache: true });
  const bySessionId = new Map<string, SessionIndexEntry>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (!entry?.sessionId) {
      continue;
    }
    bySessionId.set(entry.sessionId, { sessionKey, entry });
  }
  return bySessionId;
}

function resolveHubMessageDirs(workspaceDir: string): string[] {
  return [
    path.join(workspaceDir, "hub-data", "messages"),
    path.join(workspaceDir, "hub", "data", "messages"),
  ];
}

async function collectKnownHubPeers(workspaceDir: string): Promise<Set<string>> {
  const peers = new Set<string>();
  for (const dir of resolveHubMessageDirs(workspaceDir)) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const base = entry.name.slice(0, -".json".length).trim().toLowerCase();
      if (base) {
        peers.add(base);
      }
    }
  }
  return peers;
}

async function loadCronRunLogIndex(cfg: OpenClawConfig): Promise<Map<string, CronRunLogEntry>> {
  const storePath = resolveCronStorePath(cfg.cron?.store);
  const runsDir = path.join(path.dirname(storePath), "runs");
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const bySessionId = new Map<string, CronRunLogEntry>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const jobId = entry.name.slice(0, -".jsonl".length);
    const filePath = resolveCronRunLogPath({ storePath, jobId });
    const runEntries = await readCronRunLogEntries(filePath, { jobId }).catch(() => []);
    for (const runEntry of runEntries) {
      if (!runEntry.sessionId) {
        continue;
      }
      bySessionId.set(runEntry.sessionId, runEntry);
    }
  }
  return bySessionId;
}

async function appendChannelRecordIfNew(params: {
  cfg: OpenClawConfig;
  agentId: string;
  route: ChannelRoute;
  record: ChannelHistoryRecord;
  dedupe: Set<string>;
  summary: HistoryBackfillSummary;
}): Promise<void> {
  if (hasAnyDedupKey(params.dedupe, params.record)) {
    params.summary.duplicateRecordsSkipped += 1;
    return;
  }
  const result = await appendChannelHistoryRecord({
    cfg: params.cfg,
    agentId: params.agentId,
    surface: params.route.surface,
    conversationKey: params.route.conversationKey,
    record: params.record,
  });
  if (!result.written) {
    params.summary.filteredRecordsSkipped += 1;
    return;
  }
  addDedupKeys(params.dedupe, params.record);
  params.summary.channelRecordsWritten += 1;
}

async function appendCronRecordIfNew(params: {
  cfg: OpenClawConfig;
  agentId: string;
  route: CronRoute;
  record: CronHistoryRecord;
  dedupe: Set<string>;
  summary: HistoryBackfillSummary;
}): Promise<void> {
  if (hasAnyDedupKey(params.dedupe, params.record)) {
    params.summary.duplicateRecordsSkipped += 1;
    return;
  }
  const result = await appendCronHistoryRecord({
    cfg: params.cfg,
    agentId: params.agentId,
    jobId: params.route.jobId,
    record: params.record,
  });
  if (!result.written) {
    params.summary.filteredRecordsSkipped += 1;
    return;
  }
  addDedupKeys(params.dedupe, params.record);
  params.summary.cronRecordsWritten += 1;
}

function pickCronAssistantText(messages: TranscriptMessage[]): string | undefined {
  const nonMirror = messages.find(
    (message) =>
      message.role === "assistant" &&
      message.provider !== "openclaw" &&
      message.model !== "delivery-mirror",
  );
  if (nonMirror) {
    return parseInlineDirectives(nonMirror.text).text.trim() || undefined;
  }
  const firstAssistant = messages.find((message) => message.role === "assistant");
  return firstAssistant
    ? parseInlineDirectives(firstAssistant.text).text.trim() || undefined
    : undefined;
}

async function backfillCronTranscript(params: {
  cfg: OpenClawConfig;
  agentId: string;
  route: CronRoute;
  sessionId: string;
  messages: TranscriptMessage[];
  dedupe: Set<string>;
  summary: HistoryBackfillSummary;
  runLogBySessionId: Map<string, CronRunLogEntry>;
}): Promise<boolean> {
  const firstUser = params.messages.find((message) => message.role === "user");
  if (!firstUser) {
    return false;
  }
  const runLog = params.runLogBySessionId.get(params.sessionId);
  const startedTs = new Date(runLog?.runAtMs ?? firstUser.ts).toISOString();
  const inputText = stripCronPromptPrefix(firstUser.text);
  await appendCronRecordIfNew({
    cfg: params.cfg,
    agentId: params.agentId,
    route: params.route,
    dedupe: params.dedupe,
    summary: params.summary,
    record: {
      kind: "cron_run",
      ts: startedTs,
      jobId: params.route.jobId,
      phase: "started",
      inputText: inputText || undefined,
      sessionKey: params.route.sessionKey,
      sessionId: params.sessionId,
    },
  });

  const outputText = pickCronAssistantText(params.messages) ?? trimOptionalString(runLog?.summary);
  if (!outputText && !runLog?.error && !runLog?.status) {
    return true;
  }
  await appendCronRecordIfNew({
    cfg: params.cfg,
    agentId: params.agentId,
    route: params.route,
    dedupe: params.dedupe,
    summary: params.summary,
    record: {
      kind: "cron_run",
      ts: startedTs,
      jobId: params.route.jobId,
      phase: "finished",
      status: runLog?.status,
      inputText: inputText || undefined,
      outputText,
      error: trimOptionalString(runLog?.error),
      delivered: runLog?.delivered,
      deliveryStatus: trimOptionalString(runLog?.deliveryStatus),
      sessionKey: params.route.sessionKey ?? trimOptionalString(runLog?.sessionKey),
      sessionId: params.sessionId,
    },
  });
  return true;
}

async function backfillChannelTranscript(params: {
  cfg: OpenClawConfig;
  agentId: string;
  route: ChannelRoute;
  sessionId: string;
  messages: TranscriptMessage[];
  dedupe: Set<string>;
  summary: HistoryBackfillSummary;
}): Promise<boolean> {
  let wroteAny = false;
  for (const message of params.messages) {
    if (message.role === "user") {
      const envelope = parseTranscriptEnvelope(message.text);
      if (!envelope.text) {
        continue;
      }
      const record: ChannelHistoryRecord = {
        kind: "channel_message",
        ts: new Date(message.ts).toISOString(),
        surface: params.route.surface,
        accountId: params.route.accountId,
        conversationId: params.route.conversationKey,
        threadId: params.route.threadId,
        direction: "inbound",
        disposition: "processed",
        messageId: trimOptionalString(envelope.conversationInfo?.messageId),
        replyToId: trimOptionalString(envelope.conversationInfo?.replyToId),
        senderId:
          trimOptionalString(envelope.sender?.id) ??
          trimOptionalString(envelope.conversationInfo?.senderId),
        senderLabel:
          trimOptionalString(envelope.sender?.label) ??
          trimOptionalString(envelope.sender?.name) ??
          trimOptionalString(envelope.sender?.username) ??
          trimOptionalString(envelope.conversationInfo?.senderLabel),
        text: envelope.text,
        quotedText: trimOptionalString(envelope.replyContext?.body),
        sessionKey: params.route.sessionKey,
        sessionId: params.sessionId,
      };
      const before = params.summary.channelRecordsWritten;
      await appendChannelRecordIfNew({
        cfg: params.cfg,
        agentId: params.agentId,
        route: params.route,
        record,
        dedupe: params.dedupe,
        summary: params.summary,
      });
      if (params.summary.channelRecordsWritten > before) {
        wroteAny = true;
      }
      continue;
    }

    const cleaned = parseInlineDirectives(message.text).text.trim();
    if (!cleaned) {
      continue;
    }
    const directives = parseInlineDirectives(message.text);
    const record: ChannelHistoryRecord = {
      kind: "channel_message",
      ts: new Date(message.ts).toISOString(),
      surface: params.route.surface,
      accountId: params.route.accountId,
      conversationId: params.route.conversationKey,
      threadId: params.route.threadId,
      direction: "outbound",
      disposition: "processed",
      replyToId: trimOptionalString(directives.replyToExplicitId),
      text: cleaned,
      sessionKey: params.route.sessionKey,
      sessionId: params.sessionId,
    };
    const before = params.summary.channelRecordsWritten;
    await appendChannelRecordIfNew({
      cfg: params.cfg,
      agentId: params.agentId,
      route: params.route,
      record,
      dedupe: params.dedupe,
      summary: params.summary,
    });
    if (params.summary.channelRecordsWritten > before) {
      wroteAny = true;
    }
  }
  return wroteAny;
}

function inferTranscriptRoute(params: {
  sessionId: string;
  sessionIndexEntry?: SessionIndexEntry;
  messages: TranscriptMessage[];
  knownHubPeers: Set<string>;
}): TranscriptRoute {
  if (params.sessionIndexEntry) {
    return deriveChannelRouteFromSessionIndex({
      sessionId: params.sessionId,
      sessionKey: params.sessionIndexEntry.sessionKey,
      entry: params.sessionIndexEntry.entry,
      knownHubPeers: params.knownHubPeers,
    });
  }
  const firstUser = params.messages.find((message) => message.role === "user");
  const cronJobId = firstUser ? extractCronJobIdFromPrompt(firstUser.text) : undefined;
  if (cronJobId) {
    return {
      kind: "cron",
      jobId: cronJobId,
    };
  }
  const envelope = firstUser ? parseTranscriptEnvelope(firstUser.text) : undefined;
  return inferChannelRouteFromTranscript({
    sessionId: params.sessionId,
    envelope,
    knownHubPeers: params.knownHubPeers,
  });
}

type HubJsonRecord = {
  id?: unknown;
  from?: unknown;
  message?: unknown;
  timestamp?: unknown;
};

type HubJsonFileInfo = {
  filePath: string;
  peerBase: string;
  records: HubJsonRecord[];
  senders: Set<string>;
};

async function loadHubJsonFiles(workspaceDir: string): Promise<HubJsonFileInfo[]> {
  const files: HubJsonFileInfo[] = [];
  const dirs = resolveHubMessageDirs(workspaceDir);
  for (const dir of dirs) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(dir, entry.name);
      const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (!Array.isArray(parsed)) {
        continue;
      }
      const records = parsed as HubJsonRecord[];
      const senders = new Set(
        records
          .map((item) => normalizeLower(trimOptionalString(item.from)))
          .filter((value): value is string => Boolean(value)),
      );
      files.push({
        filePath,
        peerBase: entry.name.slice(0, -".json".length).trim(),
        records,
        senders,
      });
    }
  }
  return files;
}

async function backfillHubJson(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  transcriptCoveredHubPeers: Set<string>;
  dedupe: Set<string>;
  summary: HistoryBackfillSummary;
}): Promise<void> {
  const files = await loadHubJsonFiles(params.workspaceDir);
  params.summary.hubJsonFilesScanned = files.length;
  const senderFileCounts = new Map<string, number>();
  for (const file of files) {
    for (const sender of file.senders) {
      senderFileCounts.set(sender, (senderFileCounts.get(sender) ?? 0) + 1);
    }
  }
  const selfHubIds = new Set(
    files
      .map((file) => normalizeLower(file.peerBase))
      .filter((base): base is string => Boolean(base))
      .filter((base, index, all) => all.indexOf(base) === index)
      .filter((base) => {
        const info = files.find((entry) => normalizeLower(entry.peerBase) === base);
        if (!info) {
          return false;
        }
        return !info.senders.has(base) && (senderFileCounts.get(base) ?? 0) > 1;
      }),
  );

  for (const file of files) {
    const peerBase = file.peerBase;
    const normalizedBase = normalizeLower(peerBase);
    const isInboxFile = Boolean(normalizedBase && selfHubIds.has(normalizedBase));
    if (!isInboxFile && normalizedBase && params.transcriptCoveredHubPeers.has(normalizedBase)) {
      continue;
    }
    let fileImported = false;
    for (const item of file.records) {
      const text = trimOptionalString(item.message);
      const from = trimOptionalString(item.from);
      const ts = trimOptionalString(item.timestamp);
      if (!text || !from || !ts) {
        continue;
      }
      const filePeer = peerBase;
      const peer = isInboxFile ? from : filePeer;
      if (!peer) {
        continue;
      }
      if (params.transcriptCoveredHubPeers.has(peer.toLowerCase())) {
        continue;
      }
      const direction =
        !isInboxFile && normalizeLower(from) === normalizeLower(filePeer) ? "inbound" : "outbound";
      const record: ChannelHistoryRecord = {
        kind: "channel_message",
        ts: new Date(ts).toISOString(),
        surface: "hub",
        conversationId: `hub:${peer}`,
        direction,
        disposition: "processed",
        messageId: trimOptionalString(item.id),
        senderId: from,
        senderLabel: from,
        text,
      };
      const before = params.summary.channelRecordsWritten;
      await appendChannelRecordIfNew({
        cfg: params.cfg,
        agentId: params.agentId,
        route: {
          kind: "channel",
          surface: "hub",
          conversationKey: `hub:${peer}`,
        },
        record,
        dedupe: params.dedupe,
        summary: params.summary,
      });
      if (params.summary.channelRecordsWritten > before) {
        fileImported = true;
      }
    }
    if (fileImported) {
      params.summary.hubJsonFilesImported += 1;
    }
  }
}

export async function backfillAgentHistory(
  options: HistoryBackfillOptions,
): Promise<HistoryBackfillSummary> {
  const includeHubJson = options.includeHubJson !== false;
  const workspaceDir = resolveAgentWorkspaceDir(options.cfg, options.agentId);
  const sessionIndex = buildSessionIndex(options.agentId);
  const knownHubPeers = await collectKnownHubPeers(workspaceDir);
  const runLogBySessionId = await loadCronRunLogIndex(options.cfg);
  const { dedupe, existingRecords } = await loadExistingHistoryDedup({
    cfg: options.cfg,
    agentId: options.agentId,
  });

  const summary: HistoryBackfillSummary = {
    agentId: options.agentId,
    existingHistoryRecords: existingRecords,
    sessionFilesScanned: 0,
    sessionFilesImported: 0,
    hubJsonFilesScanned: 0,
    hubJsonFilesImported: 0,
    channelRecordsWritten: 0,
    cronRecordsWritten: 0,
    duplicateRecordsSkipped: 0,
    filteredRecordsSkipped: 0,
  };

  const transcriptCoveredHubPeers = new Set<string>();
  const transcriptPaths = await listImportableSessionTranscriptPaths(options.agentId);
  summary.sessionFilesScanned = transcriptPaths.length;

  for (const transcriptPath of transcriptPaths) {
    const fileName = path.basename(transcriptPath);
    const sessionId = parseSessionIdFromTranscriptFileName(fileName);
    if (!sessionId) {
      continue;
    }
    const messages = await readTranscriptMessages(transcriptPath);
    if (messages.length === 0) {
      continue;
    }
    const route = inferTranscriptRoute({
      sessionId,
      sessionIndexEntry: sessionIndex.get(sessionId),
      messages,
      knownHubPeers,
    });
    let imported = false;
    if (route.kind === "cron") {
      imported = await backfillCronTranscript({
        cfg: options.cfg,
        agentId: options.agentId,
        route,
        sessionId,
        messages,
        dedupe,
        summary,
        runLogBySessionId,
      });
    } else {
      if (route.surface === "hub" && route.conversationKey.startsWith("hub:")) {
        transcriptCoveredHubPeers.add(route.conversationKey.slice("hub:".length).toLowerCase());
      }
      imported = await backfillChannelTranscript({
        cfg: options.cfg,
        agentId: options.agentId,
        route,
        sessionId,
        messages,
        dedupe,
        summary,
      });
    }
    if (imported) {
      summary.sessionFilesImported += 1;
    }
  }

  if (includeHubJson) {
    await backfillHubJson({
      cfg: options.cfg,
      agentId: options.agentId,
      workspaceDir,
      transcriptCoveredHubPeers,
      dedupe,
      summary,
    });
  }

  log.info("history backfill complete", {
    agentId: options.agentId,
    sessionFilesScanned: summary.sessionFilesScanned,
    sessionFilesImported: summary.sessionFilesImported,
    hubJsonFilesScanned: summary.hubJsonFilesScanned,
    hubJsonFilesImported: summary.hubJsonFilesImported,
    channelRecordsWritten: summary.channelRecordsWritten,
    cronRecordsWritten: summary.cronRecordsWritten,
    duplicateRecordsSkipped: summary.duplicateRecordsSkipped,
    filteredRecordsSkipped: summary.filteredRecordsSkipped,
  });

  return summary;
}
