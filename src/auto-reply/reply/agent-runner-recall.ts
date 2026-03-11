import path from "node:path";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shortDiagnosticFingerprint, summarizeMemoryStatus } from "../../memory/diagnostics.js";
import { getMemorySearchManager } from "../../memory/search-manager.js";
import type { MemorySearchResult } from "../../memory/types.js";

const log = createSubsystemLogger("memory-recall");

/** Well-known bootstrap filenames that are always injected into system prompt. */
const DEFAULT_BOOTSTRAPPED_FILENAMES = new Set(["MEMORY.md", "memory.md"]);
const MEMORY_LIKE_PATH_SEGMENTS = new Set(["memory", "memory.md"]);

export type MemoryRecallSettings = {
  enabled: boolean;
  minMessageLength: number;
  maxResults: number;
  minScore: number;
  maxTokens: number;
  skipHeartbeats: boolean;
  excludeBootstrapped: boolean;
  randomSlot: boolean;
  /**
   * @deprecated Temporal decay is handled by the memory search manager.
   * This field is accepted in config for backward compatibility but has no effect.
   */
  respectTemporalDecay: boolean;
};

export function resolveMemoryRecallSettings(cfg: OpenClawConfig): MemoryRecallSettings | null {
  const raw = cfg.agents?.defaults?.memoryRecall;
  if (!raw?.enabled) {
    return null;
  }
  return {
    enabled: true,
    minMessageLength: raw.minMessageLength ?? 20,
    maxResults: raw.maxResults ?? 3,
    minScore: raw.minScore ?? 0.5,
    maxTokens: raw.maxTokens ?? 1000,
    skipHeartbeats: raw.skipHeartbeats ?? true,
    excludeBootstrapped: raw.excludeBootstrapped ?? true,
    randomSlot: raw.randomSlot ?? true,
    respectTemporalDecay: raw.respectTemporalDecay ?? true,
  };
}

/**
 * Run a pre-turn memory recall: search memory with the incoming message
 * and return formatted context to inject into the system prompt.
 *
 * Returns null if recall is disabled, skipped, or finds nothing relevant.
 */
export async function runPreTurnMemoryRecall(params: {
  cfg: OpenClawConfig;
  agentId: string;
  incomingMessage: string;
  isHeartbeat: boolean;
  bootstrappedPaths?: Set<string>;
  sessionKey?: string;
}): Promise<string | null> {
  const settings = resolveMemoryRecallSettings(params.cfg);
  if (!settings) {
    return null;
  }

  // Skip short messages (likely commands, reactions, etc.)
  if (params.incomingMessage.length < settings.minMessageLength) {
    return null;
  }

  // Skip heartbeats if configured (covers cron since cron triggers as heartbeats)
  if (settings.skipHeartbeats && params.isHeartbeat) {
    return null;
  }

  const startMs = Date.now();
  const queryFingerprint = shortDiagnosticFingerprint(params.incomingMessage);
  const searchSurfaceLines = buildSearchSurfaceLines(params.cfg, params.agentId);

  let managerResult;
  try {
    managerResult = await getMemorySearchManager({
      cfg: params.cfg,
      agentId: params.agentId,
    });
  } catch (err) {
    log.warn("memory recall: failed to get manager", {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      incomingLength: params.incomingMessage.length,
      queryFingerprint,
      err: String(err),
    });
    return formatRecallBlock({
      searchSurfaceLines,
      bodyLines: [
        `- Auto-recall backend unavailable for this turn: ${formatErrorLine(err)}.`,
        "- If the answer depends on prior system state, fetch exact evidence before answering and say retrieval was unavailable.",
      ],
    });
  }

  const { manager } = managerResult;
  if (!manager) {
    log.warn("memory recall: manager unavailable", {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      incomingLength: params.incomingMessage.length,
      queryFingerprint,
      error: managerResult.error ?? "memory manager unavailable",
    });
    return formatRecallBlock({
      searchSurfaceLines,
      bodyLines: [
        `- Auto-recall backend unavailable for this turn: ${(managerResult.error ?? "memory manager unavailable").trim()}.`,
        "- If the answer depends on prior system state, fetch exact evidence before answering and say retrieval was unavailable.",
      ],
    });
  }

  let results: MemorySearchResult[];
  const extraCandidates = (settings.excludeBootstrapped ? 3 : 0) + (settings.randomSlot ? 2 : 0);
  const requestCount = settings.maxResults + extraCandidates;
  try {
    // Request extra candidates for filtering headroom (bootstrapped exclusion + random slot)
    results = await manager.search(params.incomingMessage, {
      maxResults: requestCount,
      minScore: settings.minScore,
      sessionKey: params.sessionKey,
    });
  } catch (err) {
    const status = manager.status();
    log.warn("memory recall: search failed", {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      incomingLength: params.incomingMessage.length,
      queryFingerprint,
      requestedMaxResults: requestCount,
      minScore: settings.minScore,
      err: String(err),
      ...summarizeMemoryStatus(status),
    });
    return formatRecallBlock({
      searchSurfaceLines,
      bodyLines: [
        `- Auto-recall search failed for this turn: ${formatErrorLine(err)}.`,
        "- If the answer depends on prior system state, expand recall manually before answering.",
      ],
    });
  }

  // Filter out bootstrapped files (MEMORY.md and any explicitly provided paths)
  if (settings.excludeBootstrapped) {
    const bootstrapped = params.bootstrappedPaths ?? new Set<string>();
    results = results.filter((r) => {
      const source = r.path ?? r.source;
      if (!source) {
        return true;
      }

      // Check against well-known bootstrap filenames
      const basename = path.basename(source);
      if (DEFAULT_BOOTSTRAPPED_FILENAMES.has(basename)) {
        return false;
      }

      // Check against explicitly provided bootstrapped paths
      for (const bp of bootstrapped) {
        if (source.includes(bp) || bp.includes(source)) {
          return false;
        }
      }
      return true;
    });
  }

  if (!results.length) {
    const elapsedMs = Date.now() - startMs;
    const status = manager.status();
    log.info("memory recall: 0 results", {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      elapsedMs,
      incomingLength: params.incomingMessage.length,
      queryFingerprint,
      requestedMaxResults: requestCount,
      minScore: settings.minScore,
      ...summarizeMemoryStatus(status),
    });
    return formatRecallBlock({
      searchSurfaceLines,
      bodyLines: [
        "- No high-confidence auto-recall hits were selected for this message.",
        "- If the answer depends on prior work or exact system state, expand recall before answering.",
      ],
    });
  }

  // respectTemporalDecay: the memory search manager already applies temporal
  // decay when memorySearch.query.hybrid.temporalDecay.enabled is true
  // (per-agent or global). Scores returned already reflect decay weighting.
  // Re-ranking here would double-apply on the builtin backend and diverge
  // from per-agent config. So we trust the manager's scores as-is.

  const selected = selectRecallResults(results, settings.maxResults, settings.randomSlot);
  const snippets = selected.map(formatRecallResultLine).join("\n");

  // Rough token estimate: ~4 chars per token
  const estimatedTokens = Math.ceil(snippets.length / 4);
  let bodyLines = snippets ? snippets.split("\n") : [];
  if (estimatedTokens > settings.maxTokens) {
    const maxChars = settings.maxTokens * 4;
    const truncated = snippets.slice(0, maxChars);
    bodyLines = truncated.split("\n").filter(Boolean);
    const elapsedMs = Date.now() - startMs;
    log.info(
      `memory recall: ${selected.length} results, truncated to ~${settings.maxTokens} tokens (${elapsedMs}ms)`,
    );
    return formatRecallBlock({ searchSurfaceLines, bodyLines });
  }

  const elapsedMs = Date.now() - startMs;
  log.info(
    `memory recall: ${selected.length} results, ~${estimatedTokens} tokens (${elapsedMs}ms)`,
  );
  return formatRecallBlock({ searchSurfaceLines, bodyLines });
}

type RecallBucket =
  | "history"
  | "session"
  | "cron"
  | "config"
  | "log"
  | "memory"
  | "workspace"
  | "other";

function selectRecallResults(
  results: MemorySearchResult[],
  maxResults: number,
  randomSlot: boolean,
): MemorySearchResult[] {
  if (results.length <= maxResults) {
    return results;
  }
  const selected: MemorySearchResult[] = [];
  const selectedKeys = new Set<string>();
  const selectedBuckets = new Set<RecallBucket>();
  const deterministicBudget = randomSlot && maxResults > 1 ? maxResults - 1 : maxResults;

  for (const result of results) {
    if (selected.length >= deterministicBudget) {
      break;
    }
    const bucket = classifyRecallBucket(result.path ?? result.source);
    const key = recallResultKey(result);
    if (selectedBuckets.has(bucket) || selectedKeys.has(key)) {
      continue;
    }
    selected.push(result);
    selectedKeys.add(key);
    selectedBuckets.add(bucket);
  }

  for (const result of results) {
    if (selected.length >= deterministicBudget) {
      break;
    }
    const key = recallResultKey(result);
    if (selectedKeys.has(key)) {
      continue;
    }
    selected.push(result);
    selectedKeys.add(key);
  }

  if (randomSlot && maxResults > 1) {
    const remaining = results.filter((result) => !selectedKeys.has(recallResultKey(result)));
    if (remaining.length > 0) {
      const randomIndex = Math.floor(Math.random() * remaining.length);
      const randomResult = remaining[randomIndex];
      if (randomResult) {
        selected.push(randomResult);
      }
    }
  }

  return selected.slice(0, maxResults);
}

function recallResultKey(result: MemorySearchResult): string {
  return `${result.path ?? result.source}:${result.startLine ?? 0}:${result.endLine ?? 0}:${result.snippet}`;
}

function formatRecallResultLine(result: MemorySearchResult): string {
  const location = result.path
    ? `[${result.path}${result.startLine ? `#L${result.startLine}` : ""}]`
    : "[memory]";
  const bucketLabel = classifyRecallBucketLabel(result.path ?? result.source);
  return `- ${bucketLabel}: ${location} ${result.snippet}`;
}

function classifyRecallBucket(value?: string): RecallBucket {
  const normalized = (value ?? "").toLowerCase();
  const basename = path.basename(normalized);
  if (normalized.startsWith("history/channel/")) {
    return "history";
  }
  if (normalized.startsWith("history/cron/")) {
    return "cron";
  }
  if (normalized.startsWith("sessions/")) {
    return "session";
  }
  if (normalized.includes("/cron/") || normalized.includes("\\cron\\")) {
    return "cron";
  }
  if (
    normalized.includes("/logs/") ||
    normalized.includes("\\logs\\") ||
    basename.endsWith(".log")
  ) {
    return "log";
  }
  if (
    basename === "openclaw.json" ||
    basename.endsWith(".yaml") ||
    basename.endsWith(".yml") ||
    basename.endsWith(".toml") ||
    basename.endsWith(".ini")
  ) {
    return "config";
  }
  if (
    DEFAULT_BOOTSTRAPPED_FILENAMES.has(path.basename(value ?? "")) ||
    normalized.split("/").some((segment) => MEMORY_LIKE_PATH_SEGMENTS.has(segment))
  ) {
    return "memory";
  }
  if (
    basename.endsWith(".ts") ||
    basename.endsWith(".tsx") ||
    basename.endsWith(".js") ||
    basename.endsWith(".mjs") ||
    basename.endsWith(".cjs") ||
    basename.endsWith(".json") ||
    basename.endsWith(".jsonl") ||
    basename.endsWith(".md")
  ) {
    return "workspace";
  }
  return "other";
}

function classifyRecallBucketLabel(value?: string): string {
  switch (classifyRecallBucket(value)) {
    case "history":
      return "History";
    case "session":
      return "Session";
    case "cron":
      return "Cron";
    case "config":
      return "Config";
    case "log":
      return "Log";
    case "memory":
      return "Memory";
    case "workspace":
      return "Workspace";
    default:
      return "Artifact";
  }
}

function buildSearchSurfaceLines(cfg: OpenClawConfig, agentId: string): string[] {
  const resolved = resolveMemorySearchConfig(cfg, agentId);
  if (!resolved) {
    return [
      "Canonical memory files and any configured operational artifacts when retrieval is enabled.",
      "Exact filesystem tools remain available for anything outside the injected brief.",
    ];
  }

  const lines: string[] = [];
  if (resolved.sources.includes("memory")) {
    lines.push(
      "Canonical memory files plus allowlisted workspace text/code files from configured extra paths.",
    );
  }
  if (resolved.sources.includes("sessions")) {
    lines.push("Session transcripts included in semantic recall.");
  }
  if (resolved.sources.includes("history")) {
    lines.push("Durable history shards for conversations and cron runs.");
  }

  const loweredPaths = resolved.extraPaths.map((entry) => entry.toLowerCase());
  if (loweredPaths.some((entry) => entry.includes("/cron/") || entry.endsWith("/cron"))) {
    lines.push("Configured cron artifacts outside the durable history corpus.");
  }
  if (
    loweredPaths.some(
      (entry) =>
        entry.includes("/logs/") ||
        entry.endsWith("/logs") ||
        entry.endsWith(".log") ||
        entry.endsWith(".jsonl"),
    )
  ) {
    lines.push(
      "Configured operational logs and JSONL artifacts outside the durable history corpus.",
    );
  }
  if (
    loweredPaths.some(
      (entry) =>
        entry.endsWith("openclaw.json") ||
        entry.endsWith("/workspace") ||
        entry.includes("/workspace/"),
    )
  ) {
    lines.push("Configured workspace/config files.");
  }
  lines.push("Exact filesystem search/read tools remain available when the brief is insufficient.");
  return Array.from(new Set(lines));
}

function formatRecallBlock(params: { searchSurfaceLines: string[]; bodyLines: string[] }): string {
  const lines = [
    "## Operating Brief",
    "Use this as baseline context for the turn. It is a compact retrieval packet, not the full corpus.",
    "Indexed operating surface:",
    ...params.searchSurfaceLines.map((line) => `- ${line}`),
    "If this brief is insufficient or exact wording/current system state matters, expand recall before answering.",
    "",
    "### Auto-recalled signals",
    ...(params.bodyLines.length > 0
      ? params.bodyLines
      : ["- No high-confidence auto-recall hits were selected for this message."]),
  ];
  return lines.join("\n");
}

function formatErrorLine(err: unknown): string {
  const message = String(err).replace(/\s+/g, " ").trim();
  return message || "unknown retrieval error";
}
