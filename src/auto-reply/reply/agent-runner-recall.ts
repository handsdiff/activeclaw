import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getMemorySearchManager } from "../../memory/search-manager.js";
import type { MemorySearchResult } from "../../memory/types.js";

const log = createSubsystemLogger("memory-recall");

export type MemoryRecallSettings = {
  enabled: boolean;
  minMessageLength: number;
  maxResults: number;
  minScore: number;
  maxTokens: number;
  skipHeartbeats: boolean;
  /** @deprecated Use skipHeartbeats — cron runs trigger as heartbeats */
  skipCron: boolean;
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
    skipCron: raw.skipCron ?? true,
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

  // Skip heartbeats and cron if configured
  if (settings.skipHeartbeats && params.isHeartbeat) {
    return null;
  }
  // skipCron is covered by skipHeartbeats since cron runs trigger as heartbeats

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
    // Request extra candidates so we can filter and still fill slots
    const requestCount = settings.maxResults + (settings.randomSlot ? 2 : 0);
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

  // Filter out bootstrapped files if configured
  if (settings.excludeBootstrapped && params.bootstrappedPaths?.size) {
    results = results.filter((r) => {
      // Check if the result's source file is in the bootstrapped set
      const source = r.path ?? r.source;
      if (!source) {
        return true;
      }
      for (const bp of params.bootstrappedPaths!) {
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

  // Take top results up to maxResults
  const topResults = results.slice(0, settings.maxResults);

  // Format as context block
  const snippets = topResults
    .map((r) => {
      const location = r.path ? `[${r.path}${r.startLine ? `#L${r.startLine}` : ""}]` : "[memory]";
      return `${location}: ${r.snippet}`;
    })
    .join("\n\n");

  // Rough token estimate: ~4 chars per token
  const estimatedTokens = Math.ceil(snippets.length / 4);
  if (estimatedTokens > settings.maxTokens) {
    // Truncate to fit budget
    const maxChars = settings.maxTokens * 4;
    const truncated = snippets.slice(0, maxChars);
    const elapsedMs = Date.now() - startMs;
    log.info(
      `memory recall: ${topResults.length} results, truncated to ~${settings.maxTokens} tokens (${elapsedMs}ms)`,
    );
    return formatRecallBlock(truncated);
  }

  const elapsedMs = Date.now() - startMs;
  log.info(
    `memory recall: ${topResults.length} results, ~${estimatedTokens} tokens (${elapsedMs}ms)`,
  );
  return formatRecallBlock(snippets);
}

function formatRecallBlock(snippets: string): string {
  return `## Auto-recalled from memory\nThe following was automatically retrieved from memory based on the incoming message. Use if relevant, ignore if not.\n\n${snippets}`;
}
