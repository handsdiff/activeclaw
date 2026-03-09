import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import { assertHistoryPathWithinAgentScope, resolveAgentHistoryConfig } from "./config.js";

function encodeExtraSegmentChars(value: string): string {
  return value.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodeHistoryPathSegment(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("history path segment must not be empty");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("history path segment must not be dot-relative");
  }
  return encodeExtraSegmentChars(encodeURIComponent(trimmed));
}

export function decodeHistoryPathSegment(encoded: string): string {
  return decodeURIComponent(encoded);
}

function padSequence(seq: number, width: number): string {
  return String(seq).padStart(width, "0");
}

function resolveHistoryDay(ts: string | Date): string {
  const date = typeof ts === "string" ? new Date(ts) : ts;
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid history timestamp");
  }
  return date.toISOString().slice(0, 10);
}

export function resolveChannelHistoryShardDir(params: {
  cfg: OpenClawConfig;
  agentId: string;
  surface: string;
  conversationKey: string;
  ts: string | Date;
}): string {
  const history = resolveAgentHistoryConfig(params.cfg, params.agentId);
  const root = assertHistoryPathWithinAgentScope(history.path, params.agentId);
  return path.join(
    root,
    "channel",
    encodeHistoryPathSegment(params.surface),
    encodeHistoryPathSegment(params.conversationKey),
    resolveHistoryDay(params.ts),
  );
}

export function resolveCronHistoryShardDir(params: {
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  ts: string | Date;
}): string {
  const history = resolveAgentHistoryConfig(params.cfg, params.agentId);
  const root = assertHistoryPathWithinAgentScope(history.path, params.agentId);
  return path.join(
    root,
    "cron",
    encodeHistoryPathSegment(params.jobId),
    resolveHistoryDay(params.ts),
  );
}

export function resolveHistoryShardPath(params: {
  dir: string;
  seq: number;
  padWidth: number;
}): string {
  return path.join(params.dir, `${padSequence(params.seq, params.padWidth)}.jsonl`);
}
