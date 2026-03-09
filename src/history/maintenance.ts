import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentHistoryConfig } from "./config.js";

export type HistoryMaintenanceResult = {
  prunedFiles: number;
  prunedDirs: number;
};

function isHistoryDaySegment(segment: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(segment);
}

async function pruneEmptyDirs(root: string): Promise<number> {
  let removed = 0;
  const visit = async (dirPath: string): Promise<void> => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      await visit(path.join(dirPath, entry.name));
    }
    const remaining = await fs.readdir(dirPath).catch(() => []);
    if (remaining.length === 0 && dirPath !== root) {
      await fs.rmdir(dirPath).catch(() => undefined);
      removed += 1;
    }
  };
  await visit(root);
  return removed;
}

export async function sweepAgentHistoryRetention(params: {
  cfg: OpenClawConfig;
  agentId: string;
  now?: Date;
}): Promise<HistoryMaintenanceResult> {
  const history = resolveAgentHistoryConfig(params.cfg, params.agentId);
  const retentionDays = history.retention.days;
  if (!history.enabled || retentionDays == null) {
    return { prunedFiles: 0, prunedDirs: 0 };
  }

  const cutoff = new Date(
    (params.now ?? new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  let prunedFiles = 0;
  const root = path.resolve(history.path);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (isHistoryDaySegment(entry.name) && entry.name < cutoff) {
          const nested = await fs.readdir(entryPath).catch(() => []);
          prunedFiles += nested.filter((name) => name.endsWith(".jsonl")).length;
          await fs.rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
        stack.push(entryPath);
      }
    }
  }
  const prunedDirs = await pruneEmptyDirs(root).catch(() => 0);
  return { prunedFiles, prunedDirs };
}
