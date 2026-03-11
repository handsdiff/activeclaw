import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { stripEphemeralPromptBlocks } from "./ephemeral-context.js";
import { normalizeInputProvenance } from "./input-provenance.js";

type SessionBranchEntry = ReturnType<SessionManager["getBranch"]>[number];
type TextBlock = { type?: unknown; text?: unknown };

type EntryRewritePlan = {
  original: SessionBranchEntry;
  nextEntry?: SessionBranchEntry;
  changed: boolean;
  reason?: string;
  droppedFromContext?: boolean;
};

type UserMessageRewriteResult = {
  message: AgentMessage;
  changed: boolean;
  reason?: string;
};

function hasPersistableContent(message: AgentMessage): boolean {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type !== "text") {
      return true;
    }
    const text = (block as TextBlock).text;
    if (typeof text === "string" && text.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function rewriteLeadingTextContent(
  message: AgentMessage,
  rewrite: (text: string) => { text: string; changed: boolean },
): { message: AgentMessage; changed: boolean } {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const result = rewrite(content);
    if (!result.changed) {
      return { message, changed: false };
    }
    return {
      message: {
        ...(message as unknown as Record<string, unknown>),
        content: result.text,
      } as AgentMessage,
      changed: true,
    };
  }
  if (!Array.isArray(content)) {
    return { message, changed: false };
  }

  const nextContent = [...content];
  for (let i = 0; i < nextContent.length; i += 1) {
    const block = nextContent[i];
    if (!block || typeof block !== "object" || (block as TextBlock).type !== "text") {
      continue;
    }
    const text = (block as TextBlock).text;
    if (typeof text !== "string") {
      continue;
    }
    const result = rewrite(text);
    if (!result.changed) {
      return { message, changed: false };
    }
    nextContent[i] = { ...(block as Record<string, unknown>), text: result.text };
    return {
      message: {
        ...(message as unknown as Record<string, unknown>),
        content: nextContent,
      } as AgentMessage,
      changed: true,
    };
  }

  return { message, changed: false };
}

function stripLegacyInternalEventContext(text: string): { text: string; changed: boolean } {
  const normalized = text.replace(/\r\n/g, "\n").trimStart();
  if (!normalized.startsWith("OpenClaw runtime context (internal):")) {
    return { text, changed: false };
  }

  const fallback = "A background task finished. Process the completion update now.";
  const markerIndex = normalized.lastIndexOf(fallback);
  if (markerIndex !== -1) {
    return {
      text: normalized.slice(markerIndex).trim(),
      changed: true,
    };
  }

  const lines = normalized.split("\n");
  const extractField = (prefix: string) => {
    const line = lines.find((candidate) => candidate.toLowerCase().startsWith(prefix));
    const value = line?.slice(prefix.length).trim();
    return value ? value : undefined;
  };
  const taskLabel = extractField("task:");
  const statusLabel = extractField("status:");

  return {
    text: [
      fallback,
      taskLabel ? `Task: ${taskLabel}` : undefined,
      statusLabel ? `Status: ${statusLabel}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    changed: true,
  };
}

function looksLikeLegacyTaskCompletionContext(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").trimStart();
  if (!normalized.startsWith("OpenClaw runtime context (internal):")) {
    return false;
  }
  return (
    normalized.includes("[Internal task completion event]") ||
    normalized.includes("source: subagent") ||
    normalized.includes("source: cron") ||
    normalized.includes("type: subagent task") ||
    normalized.includes("type: cron job") ||
    normalized.includes("<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>")
  );
}

function extractLegacyTaskCompletionField(text: string, prefix: string): string | undefined {
  const normalizedPrefix = prefix.toLowerCase();
  const line = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .find((candidate) => candidate.toLowerCase().startsWith(normalizedPrefix));
  const value = line?.slice(prefix.length).trim();
  return value ? value : undefined;
}

function buildLegacyTaskCompletionProvenance(
  text: string,
  existing: ReturnType<typeof normalizeInputProvenance>,
): {
  kind: "inter_session";
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool: string;
  persistence: "ephemeral";
} {
  return {
    kind: "inter_session",
    sourceSessionKey:
      existing?.sourceSessionKey ?? extractLegacyTaskCompletionField(text, "session_key:"),
    sourceChannel: existing?.sourceChannel,
    sourceTool: existing?.sourceTool ?? "subagent_announce",
    persistence: "ephemeral",
  };
}

function getLeadingTextContent(message: AgentMessage): string | undefined {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as TextBlock).type !== "text") {
      continue;
    }
    const text = (block as TextBlock).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return undefined;
}

function rewriteUserMessageForPersistence(params: {
  message: AgentMessage;
  isSubagentSession: boolean;
}): UserMessageRewriteResult {
  const provenance = normalizeInputProvenance(
    (params.message as { provenance?: unknown }).provenance,
  );
  let nextMessage = params.message;
  let changed = false;
  let reason: string | undefined;

  const strippedEphemeral = rewriteLeadingTextContent(nextMessage, stripEphemeralPromptBlocks);
  if (strippedEphemeral.changed) {
    nextMessage = strippedEphemeral.message;
    changed = true;
    reason = "ephemeral_prompt_block";
  }

  if (
    !params.isSubagentSession &&
    ((provenance?.kind === "inter_session" && provenance.sourceTool === "subagent_announce") ||
      looksLikeLegacyTaskCompletionContext(getLeadingTextContent(nextMessage) ?? ""))
  ) {
    const legacyText = getLeadingTextContent(nextMessage) ?? "";
    const rewritten = rewriteLeadingTextContent(nextMessage, stripLegacyInternalEventContext);
    if (rewritten.changed && hasPersistableContent(rewritten.message)) {
      const rewrittenMessage = {
        ...(rewritten.message as unknown as Record<string, unknown>),
        provenance: buildLegacyTaskCompletionProvenance(legacyText, provenance),
      } as unknown as AgentMessage;
      return {
        message: rewrittenMessage,
        changed: true,
        reason: "subagent_runtime_context",
      };
    }
  }

  return {
    message: nextMessage,
    changed,
    reason,
  };
}

type PersistedSessionManagerLike = {
  _rewriteFile?: () => void;
};

type SyntheticTurnReason = "synthetic_memory_turn" | "synthetic_silent_inter_session_turn";

function isMessageEntry(
  entry: SessionBranchEntry,
): entry is SessionBranchEntry & { type: "message"; message: AgentMessage } {
  return entry.type === "message";
}

function getMessageRole(entry: SessionBranchEntry | undefined): string | undefined {
  if (!entry || !isMessageEntry(entry)) {
    return undefined;
  }
  return typeof (entry.message as { role?: unknown }).role === "string"
    ? ((entry.message as { role: string }).role ?? undefined)
    : undefined;
}

function buildElidedCustomEntry(
  entry: SessionBranchEntry & { type: "message"; message: AgentMessage },
  reason: SyntheticTurnReason,
): SessionBranchEntry {
  const originalRole =
    typeof (entry.message as { role?: unknown }).role === "string"
      ? (entry.message as { role: string }).role
      : "unknown";
  return {
    type: "custom",
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    customType: "openclaw_runtime_elided",
    data: {
      reason,
      originalType: "message",
      originalRole,
    },
  } as SessionBranchEntry;
}

function replaceEntryContents(target: SessionBranchEntry, source: SessionBranchEntry): void {
  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    delete targetRecord[key];
  }
  Object.assign(targetRecord, sourceRecord);
}

function extractAssistantText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      return typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "";
    })
    .join("\n")
    .trim();
}

function collectTurnMessageIndexes(entries: SessionBranchEntry[], startIndex: number): number[] {
  const indexes: number[] = [];
  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isMessageEntry(entry)) {
      break;
    }
    const role = getMessageRole(entry);
    if (index !== startIndex && role === "user") {
      break;
    }
    indexes.push(index);
  }
  return indexes;
}

function resolveSyntheticTurnRewrite(params: {
  entries: SessionBranchEntry[];
  startIndex: number;
}): { indexes: number[]; reason: SyntheticTurnReason } | undefined {
  const startEntry = params.entries[params.startIndex];
  if (!isMessageEntry(startEntry) || getMessageRole(startEntry) !== "user") {
    return undefined;
  }
  const provenance = normalizeInputProvenance(
    (startEntry.message as { provenance?: unknown }).provenance,
  );
  if (provenance?.persistence !== "ephemeral") {
    return undefined;
  }

  const indexes = collectTurnMessageIndexes(params.entries, params.startIndex);
  if (indexes.length === 0) {
    return undefined;
  }

  if (provenance.kind === "internal_system" && provenance.sourceTool === "memory_flush") {
    return { indexes, reason: "synthetic_memory_turn" };
  }

  if (provenance.kind === "inter_session" && provenance.sourceTool === "subagent_announce") {
    if (looksLikeLegacyTaskCompletionContext(getLeadingTextContent(startEntry.message) ?? "")) {
      return undefined;
    }
    const turnEntries = indexes.map((index) => params.entries[index]).filter(isMessageEntry);
    const hasToolResult = turnEntries.some((entry) => getMessageRole(entry) === "toolResult");
    if (hasToolResult) {
      return undefined;
    }
    const lastAssistant = turnEntries
      .toReversed()
      .find((entry) => getMessageRole(entry) === "assistant");
    if (!lastAssistant) {
      return undefined;
    }
    if (!isSilentReplyText(extractAssistantText(lastAssistant.message), SILENT_REPLY_TOKEN)) {
      return undefined;
    }
    return { indexes, reason: "synthetic_silent_inter_session_turn" };
  }

  return undefined;
}

function persistRewrittenSessionBranch(sessionManager: SessionManager): void {
  const persistedSessionManager = sessionManager as unknown as PersistedSessionManagerLike;
  if (typeof persistedSessionManager._rewriteFile === "function") {
    persistedSessionManager._rewriteFile();
  }
}

function buildEntryRewritePlan(params: {
  entries: SessionBranchEntry[];
  isSubagentSession: boolean;
}): {
  plans: EntryRewritePlan[];
  firstChangedIndex: number;
  rewrittenEntries: number;
  droppedEntries: number;
} {
  const plans: EntryRewritePlan[] = [];
  let firstChangedIndex = -1;
  let rewrittenEntries = 0;
  let droppedEntries = 0;

  for (let index = 0; index < params.entries.length; index += 1) {
    const entry = params.entries[index];
    const syntheticTurn = resolveSyntheticTurnRewrite({
      entries: params.entries,
      startIndex: index,
    });
    if (syntheticTurn) {
      for (const syntheticIndex of syntheticTurn.indexes) {
        const syntheticEntry = params.entries[syntheticIndex];
        if (!isMessageEntry(syntheticEntry)) {
          continue;
        }
        const plan: EntryRewritePlan = {
          original: syntheticEntry,
          nextEntry: buildElidedCustomEntry(syntheticEntry, syntheticTurn.reason),
          changed: true,
          reason: syntheticTurn.reason,
          droppedFromContext: true,
        };
        if (firstChangedIndex === -1) {
          firstChangedIndex = syntheticIndex;
        }
        rewrittenEntries += 1;
        droppedEntries += 1;
        plans.push(plan);
      }
      index = syntheticTurn.indexes[syntheticTurn.indexes.length - 1] ?? index;
      continue;
    }

    let plan: EntryRewritePlan = {
      original: entry,
      changed: false,
    };

    if (entry.type === "message" && (entry.message as { role?: unknown }).role === "user") {
      const rewritten = rewriteUserMessageForPersistence({
        message: entry.message,
        isSubagentSession: params.isSubagentSession,
      });
      if (rewritten.changed) {
        plan = {
          original: entry,
          nextEntry: {
            ...entry,
            message: rewritten.message,
          },
          changed: true,
          reason: rewritten.reason ?? "user_message_rewrite",
        };
      }
    }

    if (plan.changed && firstChangedIndex === -1) {
      firstChangedIndex = index;
    }
    if (plan.changed) {
      rewrittenEntries += 1;
    }
    plans.push(plan);
  }

  return {
    plans,
    firstChangedIndex,
    rewrittenEntries,
    droppedEntries,
  };
}

export function rewriteSessionTranscriptForPersistence(params: {
  sessionManager: SessionManager;
  sessionKey?: string;
}): {
  changed: boolean;
  messages: AgentMessage[];
  droppedEntries: number;
  rewrittenEntries: number;
  rewriteFloorIndex: number;
  skippedPreCompactionChanges: number;
  changeReasons: Record<string, number>;
} {
  const entries = params.sessionManager.getBranch();
  const lastCompactionIndex = entries.findLastIndex((entry) => entry.type === "compaction");
  const legacyRewriteFloorIndex = lastCompactionIndex + 1;
  if (entries.length === 0) {
    return {
      changed: false,
      messages: params.sessionManager.buildSessionContext().messages,
      droppedEntries: 0,
      rewrittenEntries: 0,
      rewriteFloorIndex: legacyRewriteFloorIndex,
      skippedPreCompactionChanges: 0,
      changeReasons: {},
    };
  }
  const plan = buildEntryRewritePlan({
    entries,
    isSubagentSession: (params.sessionKey ?? "").toLowerCase().includes(":subagent:"),
  });
  if (plan.firstChangedIndex === -1) {
    return {
      changed: false,
      messages: params.sessionManager.buildSessionContext().messages,
      droppedEntries: 0,
      rewrittenEntries: 0,
      rewriteFloorIndex: legacyRewriteFloorIndex,
      skippedPreCompactionChanges: 0,
      changeReasons: {},
    };
  }
  const changeReasons: Record<string, number> = {};
  for (const entryPlan of plan.plans) {
    if (entryPlan.changed && entryPlan.reason) {
      if (entryPlan.nextEntry) {
        replaceEntryContents(entryPlan.original, entryPlan.nextEntry);
      }
      changeReasons[entryPlan.reason] = (changeReasons[entryPlan.reason] ?? 0) + 1;
    }
  }
  persistRewrittenSessionBranch(params.sessionManager);

  return {
    changed: true,
    messages: params.sessionManager.buildSessionContext().messages,
    droppedEntries: plan.droppedEntries,
    rewrittenEntries: plan.rewrittenEntries,
    rewriteFloorIndex: 0,
    skippedPreCompactionChanges: 0,
    changeReasons,
  };
}
