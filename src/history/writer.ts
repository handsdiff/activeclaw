import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentHistoryConfig } from "./config.js";
import {
  resolveChannelHistoryShardDir,
  resolveCronHistoryShardDir,
  resolveHistoryShardPath,
} from "./paths.js";
import type { ChannelHistoryRecord, CronHistoryRecord, HistoryRecord } from "./types.js";

const writesByKey = new Map<string, Promise<void>>();

export type HistoryAppendResult = {
  written: boolean;
  path?: string;
};

type HistoryShardTarget =
  | {
      kind: "channel";
      surface: string;
      conversationKey: string;
    }
  | {
      kind: "cron";
      jobId: string;
    };

async function setSecureFileMode(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function setSecureDirMode(dirPath: string): Promise<void> {
  await fs.chmod(dirPath, 0o700).catch(() => undefined);
}

async function resolveNextShardPath(params: {
  dir: string;
  padWidth: number;
  nextWriteBytes: number;
  maxBytes: number;
}): Promise<string> {
  const entries = await fs.readdir(params.dir, { withFileTypes: true }).catch(() => []);
  const shardSeqs = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name.match(/^(\d+)\.jsonl$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isFinite(value) && value > 0)
    .toSorted((left, right) => left - right);
  const lastSeq = shardSeqs.at(-1) ?? 0;
  if (lastSeq > 0) {
    const lastPath = resolveHistoryShardPath({
      dir: params.dir,
      seq: lastSeq,
      padWidth: params.padWidth,
    });
    const lastStat = await fs.stat(lastPath).catch(() => null);
    if (lastStat && lastStat.size + params.nextWriteBytes <= params.maxBytes) {
      return lastPath;
    }
  }
  return resolveHistoryShardPath({
    dir: params.dir,
    seq: lastSeq + 1,
    padWidth: params.padWidth,
  });
}

async function appendRecord(params: {
  cfg: OpenClawConfig;
  agentId: string;
  target: HistoryShardTarget;
  record: HistoryRecord;
}): Promise<HistoryAppendResult> {
  const history = resolveAgentHistoryConfig(params.cfg, params.agentId);
  if (!history.enabled) {
    return { written: false };
  }
  let record: HistoryRecord = params.record;
  if (params.target.kind === "channel") {
    if (!history.channel.enabled) {
      return { written: false };
    }
    if (
      history.channel.surfaces.length > 0 &&
      !history.channel.surfaces.includes(params.target.surface)
    ) {
      return { written: false };
    }
    if (history.exclude.conversations.includes(params.target.conversationKey)) {
      return { written: false };
    }
    if (
      record.kind === "channel_message" &&
      record.direction === "inbound" &&
      record.disposition !== "processed" &&
      !history.channel.includeNonDispatchedInbound
    ) {
      return { written: false };
    }
    if (record.kind === "channel_message" && !history.channel.includeQuotedContext) {
      record = { ...record, quotedText: undefined };
    }
  }
  if (params.target.kind === "cron") {
    if (!history.cron.enabled || history.exclude.jobs.includes(params.target.jobId)) {
      return { written: false };
    }
  }

  const shardDir =
    params.target.kind === "channel"
      ? resolveChannelHistoryShardDir({
          cfg: params.cfg,
          agentId: params.agentId,
          surface: params.target.surface,
          conversationKey: params.target.conversationKey,
          ts: record.ts,
        })
      : resolveCronHistoryShardDir({
          cfg: params.cfg,
          agentId: params.agentId,
          jobId: params.target.jobId,
          ts: record.ts,
        });

  const resolvedDir = path.resolve(shardDir);
  const payload = `${JSON.stringify(record)}\n`;
  const pending = writesByKey.get(resolvedDir) ?? Promise.resolve();
  let writtenPath = "";
  const next = pending
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(resolvedDir, { recursive: true, mode: 0o700 });
      await setSecureDirMode(resolvedDir);
      const targetPath = await resolveNextShardPath({
        dir: resolvedDir,
        padWidth: history.shard.padWidth,
        nextWriteBytes: Buffer.byteLength(payload),
        maxBytes: history.shard.maxBytes,
      });
      await fs.appendFile(targetPath, payload, { encoding: "utf-8", mode: 0o600 });
      await setSecureFileMode(targetPath);
      writtenPath = targetPath;
    });
  writesByKey.set(resolvedDir, next);
  try {
    await next;
  } finally {
    if (writesByKey.get(resolvedDir) === next) {
      writesByKey.delete(resolvedDir);
    }
  }

  return { written: true, path: writtenPath };
}

export async function appendChannelHistoryRecord(params: {
  cfg: OpenClawConfig;
  agentId: string;
  surface: string;
  conversationKey: string;
  record: ChannelHistoryRecord;
}): Promise<HistoryAppendResult> {
  return await appendRecord({
    cfg: params.cfg,
    agentId: params.agentId,
    target: {
      kind: "channel",
      surface: params.surface,
      conversationKey: params.conversationKey,
    },
    record: params.record,
  });
}

export async function appendCronHistoryRecord(params: {
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  record: CronHistoryRecord;
}): Promise<HistoryAppendResult> {
  return await appendRecord({
    cfg: params.cfg,
    agentId: params.agentId,
    target: {
      kind: "cron",
      jobId: params.jobId,
    },
    record: params.record,
  });
}
