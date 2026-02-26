import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getMemorySearchManager } from "../../memory/search-manager.js";
import type { MemorySearchResult } from "../../memory/types.js";

const log = createSubsystemLogger("memory-recall");

/** Well-known bootstrap filenames that are always injected into system prompt. */
const DEFAULT_BOOTSTRAPPED_FILENAMES = new Set(["MEMORY.md", "memory.md"]);

export type MemoryRecallSettings = {
  enabled: boolean;
  minMessageLength: number;
  maxResults: number;
  minScore: number;
  maxTokens: number;
  skipHeartbeats: boolean;
  excludeBootstrapped: boolean;
  randomSlot: boolean;
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

  let managerResult;
  try {
    managerResult = await getMemorySearchManager({
      cfg: params.cfg,
      agentId: params.agentId,
    });
  } catch (err) {
    log.warn(`memory recall: failed to get manager: ${String(err)}`);
    return null;
  }

  const { manager } = managerResult;
  if (!manager) {
    return null;
  }

  let results: MemorySearchResult[];
  try {
    // Request extra candidates for filtering headroom (bootstrapped exclusion + random slot)
    const extraCandidates = (settings.excludeBootstrapped ? 3 : 0) + (settings.randomSlot ? 2 : 0);
    const requestCount = settings.maxResults + extraCandidates;
    results = await manager.search(params.incomingMessage, {
      maxResults: requestCount,
      minScore: settings.minScore,
      sessionKey: params.sessionKey,
    });
  } catch (err) {
    log.warn(`memory recall: search failed: ${String(err)}`);
    return null;
  }

  if (!results.length) {
    return null;
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
    return null;
  }

  // Apply temporal decay weighting if enabled
  // Extracts dates from memory file paths (memory/YYYY-MM-DD.md) to estimate age
  if (settings.respectTemporalDecay) {
    const now = Date.now();
    const halfLifeMs = resolveTemporalHalfLifeMs(params.cfg);
    const datePattern = /(\d{4}-\d{2}-\d{2})/;
    results = results.map((r) => {
      const match = r.path ? datePattern.exec(r.path) : null;
      if (!match) {
        return r;
      }
      const fileDate = new Date(match[1]).getTime();
      if (isNaN(fileDate)) {
        return r;
      }
      const ageMs = now - fileDate;
      // Exponential decay: score *= 2^(-age/halfLife)
      // Blend: 70% similarity + 30% recency to avoid pure recency domination
      const decayFactor = Math.pow(2, -ageMs / halfLifeMs);
      const adjustedScore = r.score * 0.7 + r.score * decayFactor * 0.3;
      return { ...r, score: adjustedScore };
    });
    // Re-sort by adjusted score
    results.sort((a, b) => b.score - a.score);
  }

  // Select results: top N-1 by score + 1 random slot if enabled
  let selected: MemorySearchResult[];
  if (settings.randomSlot && results.length > settings.maxResults) {
    // Take top (maxResults - 1) by score
    const topResults = results.slice(0, settings.maxResults - 1);
    // Pick one random result from the remaining candidates
    const remaining = results.slice(settings.maxResults - 1);
    const randomIndex = Math.floor(Math.random() * remaining.length);
    const randomResult = remaining[randomIndex];
    selected = [...topResults, randomResult];
  } else {
    selected = results.slice(0, settings.maxResults);
  }

  // Format as context block
  const snippets = selected
    .map((r) => {
      const location = r.path ? `[${r.path}${r.startLine ? `#L${r.startLine}` : ""}]` : "[memory]";
      return `${location}: ${r.snippet}`;
    })
    .join("\n\n");

  // Rough token estimate: ~4 chars per token
  const estimatedTokens = Math.ceil(snippets.length / 4);
  if (estimatedTokens > settings.maxTokens) {
    const maxChars = settings.maxTokens * 4;
    const truncated = snippets.slice(0, maxChars);
    const elapsedMs = Date.now() - startMs;
    log.info(
      `memory recall: ${selected.length} results, truncated to ~${settings.maxTokens} tokens (${elapsedMs}ms)`,
    );
    return formatRecallBlock(truncated);
  }

  const elapsedMs = Date.now() - startMs;
  log.info(
    `memory recall: ${selected.length} results, ~${estimatedTokens} tokens (${elapsedMs}ms)`,
  );
  return formatRecallBlock(snippets);
}

/**
 * Resolve temporal decay half-life from the existing memorySearch config,
 * falling back to 14 days if not configured.
 */
function resolveTemporalHalfLifeMs(cfg: OpenClawConfig): number {
  const halfLifeDays =
    cfg.agents?.defaults?.memorySearch?.query?.hybrid?.temporalDecay?.halfLifeDays ?? 14;
  return halfLifeDays * 24 * 60 * 60 * 1000;
}

function formatRecallBlock(snippets: string): string {
  return `## Auto-recalled from memory\nThe following was automatically retrieved from memory based on the incoming message. Use if relevant, ignore if not.\n\n${snippets}`;
}
