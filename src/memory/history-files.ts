import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentHistoryConfig } from "../history/config.js";
import type { ChannelHistoryRecord, CronHistoryRecord, HistoryRecord } from "../history/types.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText } from "./internal.js";

const log = createSubsystemLogger("memory");

export type HistoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
  lineMap: number[];
};

function historyPathForFile(absPath: string, rootDir: string): string {
  return path.join("history", path.relative(rootDir, absPath)).replace(/\\/g, "/");
}

async function walkHistoryDir(dir: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkHistoryDir(full, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
}

export async function listHistoryFilesForAgent(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<string[]> {
  const history = resolveAgentHistoryConfig(cfg, agentId);
  if (!history.enabled) {
    return [];
  }
  const files: string[] = [];
  await walkHistoryDir(history.path, files);
  return files;
}

function normalizeHistoryText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderChannelRecord(record: ChannelHistoryRecord): string | null {
  const body = normalizeHistoryText(record.text);
  const quoted = normalizeHistoryText(record.quotedText ?? "");
  if (!body && !quoted) {
    return null;
  }
  const parts = [
    `[${record.surface}]`,
    record.direction,
    record.disposition,
    record.senderLabel ? `${record.senderLabel}:` : undefined,
    body || undefined,
    quoted ? `Quoted: ${quoted}` : undefined,
  ].filter(Boolean);
  return parts.join(" ");
}

function renderCronRecord(record: CronHistoryRecord): string | null {
  const inputText = normalizeHistoryText(record.inputText ?? "");
  const outputText = normalizeHistoryText(record.outputText ?? "");
  const errorText = normalizeHistoryText(record.error ?? "");
  const parts = [
    `[cron:${record.jobId}]`,
    record.phase,
    record.status,
    inputText ? `Input: ${inputText}` : undefined,
    outputText ? `Output: ${outputText}` : undefined,
    errorText ? `Error: ${errorText}` : undefined,
  ].filter(Boolean);
  const text = parts.join(" ");
  return text || null;
}

function renderHistoryRecord(record: HistoryRecord): string | null {
  if (record.kind === "channel_message") {
    return renderChannelRecord(record);
  }
  if (record.kind === "cron_run") {
    return renderCronRecord(record);
  }
  return null;
}

export async function buildHistoryEntry(
  absPath: string,
  cfg: OpenClawConfig,
  agentId: string,
): Promise<HistoryFileEntry | null> {
  const history = resolveAgentHistoryConfig(cfg, agentId);
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const collected: string[] = [];
    const lineMap: number[] = [];
    for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx += 1) {
      const line = lines[jsonlIdx];
      if (!line.trim()) {
        continue;
      }
      let record: HistoryRecord;
      try {
        record = JSON.parse(line) as HistoryRecord;
      } catch {
        continue;
      }
      const text = renderHistoryRecord(record);
      if (!text) {
        continue;
      }
      const safe = redactSensitiveText(text, { mode: "tools" });
      collected.push(safe);
      lineMap.push(jsonlIdx + 1);
    }
    const content = collected.join("\n");
    return {
      path: historyPathForFile(absPath, history.path),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(content + "\n" + lineMap.join(",")),
      content,
      lineMap,
    };
  } catch (err) {
    log.debug(`Failed reading history file ${absPath}: ${String(err)}`);
    return null;
  }
}
