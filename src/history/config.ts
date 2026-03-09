import path from "node:path";
import { parseByteSize } from "../cli/parse-bytes.js";
import { resolveStateDir } from "../config/paths.js";
import type { AgentHistoryConfig } from "../config/types.history.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { clampInt, resolveUserPath } from "../utils.js";

export type ResolvedHistoryConfig = {
  enabled: boolean;
  path: string;
  channel: {
    enabled: boolean;
    surfaces: string[];
    includeQuotedContext: boolean;
    includeNonDispatchedInbound: boolean;
  };
  cron: {
    enabled: boolean;
  };
  shard: {
    maxBytes: number;
    padWidth: number;
  };
  retention: {
    days?: number;
  };
  exclude: {
    conversations: string[];
    jobs: string[];
  };
};

export const DEFAULT_HISTORY_SHARD_MAX_BYTES = 192 * 1024;
export const DEFAULT_HISTORY_SHARD_PAD_WIDTH = 4;

export function resolveDefaultAgentHistoryDir(agentId: string): string {
  return path.join(resolveStateDir(process.env), "agents", normalizeAgentId(agentId), "history");
}

export function resolveAgentHistoryPath(rawPath: string | undefined, agentId: string): string {
  if (!rawPath?.trim()) {
    return resolveDefaultAgentHistoryDir(agentId);
  }
  const withToken = rawPath.includes("{agentId}")
    ? rawPath.replaceAll("{agentId}", normalizeAgentId(agentId))
    : rawPath;
  return resolveUserPath(withToken);
}

export function getAgentHistoryScopeRoot(agentId: string): string {
  return path.join(resolveStateDir(process.env), "agents", normalizeAgentId(agentId));
}

export function assertHistoryPathWithinAgentScope(resolvedPath: string, agentId: string): string {
  const scopeRoot = path.resolve(getAgentHistoryScopeRoot(agentId));
  const candidate = path.resolve(resolvedPath);
  const relative = path.relative(scopeRoot, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new Error(`history path must stay under ${scopeRoot}`);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function mergeHistoryConfig(
  defaults: AgentHistoryConfig | undefined,
  overrides: AgentHistoryConfig | undefined,
  agentId: string,
): ResolvedHistoryConfig {
  const enabled = overrides?.enabled ?? defaults?.enabled ?? false;
  const pathValue = assertHistoryPathWithinAgentScope(
    resolveAgentHistoryPath(overrides?.path ?? defaults?.path, agentId),
    agentId,
  );
  const channelSurfaces = uniqueStrings([
    ...(defaults?.channel?.surfaces ?? []),
    ...(overrides?.channel?.surfaces ?? []),
  ]);
  const excludedConversations = uniqueStrings([
    ...(defaults?.exclude?.conversations ?? []),
    ...(overrides?.exclude?.conversations ?? []),
  ]);
  const excludedJobs = uniqueStrings([
    ...(defaults?.exclude?.jobs ?? []),
    ...(overrides?.exclude?.jobs ?? []),
  ]);
  const rawShardMaxBytes = overrides?.shard?.maxBytes ?? defaults?.shard?.maxBytes;
  const shardMaxBytes =
    typeof rawShardMaxBytes === "string"
      ? parseByteSize(rawShardMaxBytes, { defaultUnit: "b" })
      : (rawShardMaxBytes ?? DEFAULT_HISTORY_SHARD_MAX_BYTES);

  return {
    enabled,
    path: pathValue,
    channel: {
      enabled: overrides?.channel?.enabled ?? defaults?.channel?.enabled ?? enabled,
      surfaces: channelSurfaces,
      includeQuotedContext:
        overrides?.channel?.includeQuotedContext ?? defaults?.channel?.includeQuotedContext ?? true,
      includeNonDispatchedInbound:
        overrides?.channel?.includeNonDispatchedInbound ??
        defaults?.channel?.includeNonDispatchedInbound ??
        true,
    },
    cron: {
      enabled: overrides?.cron?.enabled ?? defaults?.cron?.enabled ?? enabled,
    },
    shard: {
      maxBytes: Math.max(4096, shardMaxBytes),
      padWidth: clampInt(
        overrides?.shard?.padWidth ?? defaults?.shard?.padWidth ?? DEFAULT_HISTORY_SHARD_PAD_WIDTH,
        1,
        12,
      ),
    },
    retention: {
      days: overrides?.retention?.days ?? defaults?.retention?.days,
    },
    exclude: {
      conversations: excludedConversations,
      jobs: excludedJobs,
    },
  };
}

export function resolveAgentHistoryConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedHistoryConfig {
  const normalizedAgentId = normalizeAgentId(agentId);
  const defaults = cfg.agents?.defaults?.history;
  const overrides = cfg.agents?.list?.find((entry) => entry.id === normalizedAgentId)?.history;
  return mergeHistoryConfig(defaults, overrides, normalizedAgentId);
}
