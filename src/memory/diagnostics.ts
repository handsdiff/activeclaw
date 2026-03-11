import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { hashText } from "./internal.js";
import type { MemoryProviderStatus, MemorySource } from "./types.js";

const SHORT_FINGERPRINT_CHARS = 12;
const MAX_LOGGED_PATHS = 8;

type MemoryIndexMetaLike = {
  model: string;
  provider: string;
  providerKey?: string;
  sources?: MemorySource[];
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
};

type ReadonlyRecoverySummary = {
  attempts?: number;
  successes?: number;
  failures?: number;
  lastError?: string;
};

export function shortDiagnosticFingerprint(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return hashText(value).slice(0, SHORT_FINGERPRINT_CHARS);
}

function summarizePaths(paths: string[] | undefined): {
  count: number;
  paths?: string[];
  truncatedCount?: number;
} {
  const entries = (paths ?? []).filter(Boolean);
  if (entries.length === 0) {
    return { count: 0 };
  }
  if (entries.length <= MAX_LOGGED_PATHS) {
    return { count: entries.length, paths: entries };
  }
  return {
    count: entries.length,
    paths: entries.slice(0, MAX_LOGGED_PATHS),
    truncatedCount: entries.length - MAX_LOGGED_PATHS,
  };
}

function normalizeSources(sources: MemorySource[] | undefined): MemorySource[] {
  const normalized = Array.from(
    new Set(
      (sources ?? []).filter(
        (source): source is MemorySource =>
          source === "memory" || source === "sessions" || source === "history",
      ),
    ),
  ).toSorted();
  return normalized.length > 0 ? normalized : ["memory"];
}

function readReadonlyRecovery(status: MemoryProviderStatus): ReadonlyRecoverySummary | undefined {
  const value = status.custom?.readonlyRecovery;
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const recovery = value as Record<string, unknown>;
  const attempts = typeof recovery.attempts === "number" ? recovery.attempts : undefined;
  const successes = typeof recovery.successes === "number" ? recovery.successes : undefined;
  const failures = typeof recovery.failures === "number" ? recovery.failures : undefined;
  const lastError = typeof recovery.lastError === "string" ? recovery.lastError : undefined;
  if (
    attempts === undefined &&
    successes === undefined &&
    failures === undefined &&
    lastError === undefined
  ) {
    return undefined;
  }
  return { attempts, successes, failures, lastError };
}

export function describeMemoryReindexReasons(params: {
  force?: boolean;
  meta: MemoryIndexMetaLike | null;
  providerId: string | null;
  providerModel: string | null;
  providerKey: string | null | undefined;
  configuredSources: MemorySource[];
  settings: Pick<ResolvedMemorySearchConfig, "chunking">;
  vectorReady: boolean;
}): string[] {
  const reasons: string[] = [];
  if (params.force) {
    reasons.push("forced");
  }
  if (!params.meta) {
    reasons.push("missing-meta");
    return reasons;
  }
  if (params.providerModel && params.meta.model !== params.providerModel) {
    reasons.push(`model:${params.meta.model}->${params.providerModel}`);
  }
  if (params.providerId && params.meta.provider !== params.providerId) {
    reasons.push(`provider:${params.meta.provider}->${params.providerId}`);
  }
  if (params.meta.providerKey !== params.providerKey) {
    reasons.push(
      `providerKey:${shortDiagnosticFingerprint(params.meta.providerKey) ?? "none"}->${shortDiagnosticFingerprint(params.providerKey) ?? "none"}`,
    );
  }
  const previousSources = normalizeSources(params.meta.sources);
  const nextSources = normalizeSources(params.configuredSources);
  if (JSON.stringify(previousSources) !== JSON.stringify(nextSources)) {
    reasons.push(`sources:${previousSources.join("+")}->${nextSources.join("+")}`);
  }
  if (params.meta.chunkTokens !== params.settings.chunking.tokens) {
    reasons.push(`chunkTokens:${params.meta.chunkTokens}->${params.settings.chunking.tokens}`);
  }
  if (params.meta.chunkOverlap !== params.settings.chunking.overlap) {
    reasons.push(`chunkOverlap:${params.meta.chunkOverlap}->${params.settings.chunking.overlap}`);
  }
  if (params.vectorReady && !params.meta.vectorDims) {
    reasons.push("vectorDims:missing");
  }
  return reasons;
}

export function summarizeMemoryIndexMeta(meta: MemoryIndexMetaLike | null | undefined) {
  if (!meta) {
    return null;
  }
  return {
    provider: meta.provider,
    model: meta.model,
    providerKeyFingerprint: shortDiagnosticFingerprint(meta.providerKey),
    sources: normalizeSources(meta.sources),
    chunkTokens: meta.chunkTokens,
    chunkOverlap: meta.chunkOverlap,
    vectorDims: meta.vectorDims,
  };
}

export function summarizeResolvedMemoryConfig(params: {
  agentId: string;
  workspaceDir: string;
  settings: ResolvedMemorySearchConfig;
  purpose?: "default" | "status";
  cacheKey?: string;
  requestedProvider?: string;
  resolvedProvider?: string | null;
  resolvedModel?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  providerKey?: string | null;
}) {
  const {
    count: extraPathCount,
    paths: extraPaths,
    truncatedCount: extraPathsTruncated,
  } = summarizePaths(params.settings.extraPaths);
  const {
    count: excludePathCount,
    paths: excludePaths,
    truncatedCount: excludePathsTruncated,
  } = summarizePaths(params.settings.excludePaths);
  const resolvedProvider = params.resolvedProvider ?? "none";
  return {
    agentId: params.agentId,
    purpose: params.purpose ?? "default",
    workspaceDir: params.workspaceDir,
    storePath: params.settings.store.path,
    cacheKeyFingerprint: shortDiagnosticFingerprint(params.cacheKey),
    settingsFingerprint: shortDiagnosticFingerprint(JSON.stringify(params.settings)),
    providerKeyFingerprint: shortDiagnosticFingerprint(params.providerKey),
    requestedProvider: params.requestedProvider ?? params.settings.provider,
    resolvedProvider,
    resolvedModel: params.resolvedModel ?? (resolvedProvider === "none" ? "fts-only" : undefined),
    providerUnavailableReason: params.providerUnavailableReason,
    fallback:
      params.fallbackFrom || params.fallbackReason
        ? {
            from: params.fallbackFrom,
            reason: params.fallbackReason,
          }
        : undefined,
    sources: normalizeSources(params.settings.sources),
    extraPathCount,
    extraPaths,
    extraPathsTruncated,
    excludePathCount,
    excludePaths,
    excludePathsTruncated,
    remote: {
      hasBaseUrl: Boolean(params.settings.remote?.baseUrl),
      hasApiKey: Boolean(params.settings.remote?.apiKey),
      hasHeaders: Boolean(
        params.settings.remote?.headers && Object.keys(params.settings.remote.headers).length > 0,
      ),
      batchEnabled: Boolean(params.settings.remote?.batch?.enabled),
    },
    store: {
      driver: params.settings.store.driver,
      vectorEnabled: params.settings.store.vector.enabled,
      hasVectorExtensionPath: Boolean(params.settings.store.vector.extensionPath),
    },
    sync: {
      onSessionStart: params.settings.sync.onSessionStart,
      onSearch: params.settings.sync.onSearch,
      watch: params.settings.sync.watch,
      watchDebounceMs: params.settings.sync.watchDebounceMs,
      intervalMinutes: params.settings.sync.intervalMinutes,
      sessionDeltaBytes: params.settings.sync.sessions.deltaBytes,
      sessionDeltaMessages: params.settings.sync.sessions.deltaMessages,
    },
    query: {
      maxResults: params.settings.query.maxResults,
      minScore: params.settings.query.minScore,
      hybridEnabled: params.settings.query.hybrid.enabled,
      candidateMultiplier: params.settings.query.hybrid.candidateMultiplier,
      vectorWeight: params.settings.query.hybrid.vectorWeight,
      textWeight: params.settings.query.hybrid.textWeight,
      mmrEnabled: params.settings.query.hybrid.mmr.enabled,
      temporalDecayEnabled: params.settings.query.hybrid.temporalDecay.enabled,
      temporalDecayHalfLifeDays: params.settings.query.hybrid.temporalDecay.halfLifeDays,
    },
    cache: {
      enabled: params.settings.cache.enabled,
      maxEntries: params.settings.cache.maxEntries,
    },
  };
}

export function summarizeMemoryStatus(status: MemoryProviderStatus) {
  const {
    count: extraPathCount,
    paths: extraPaths,
    truncatedCount: extraPathsTruncated,
  } = summarizePaths(status.extraPaths);
  const {
    count: excludePathCount,
    paths: excludePaths,
    truncatedCount: excludePathsTruncated,
  } = summarizePaths(status.excludePaths);
  const searchMode =
    typeof status.custom?.searchMode === "string" ? status.custom.searchMode : undefined;
  const providerUnavailableReason =
    typeof status.custom?.providerUnavailableReason === "string"
      ? status.custom.providerUnavailableReason
      : undefined;
  return {
    backend: status.backend,
    provider: status.provider,
    model: status.model,
    requestedProvider: status.requestedProvider,
    searchMode,
    files: status.files,
    chunks: status.chunks,
    dirty: status.dirty,
    workspaceDir: status.workspaceDir,
    dbPath: status.dbPath,
    sources: Array.isArray(status.sources) ? normalizeSources(status.sources) : undefined,
    sourceCounts: (status.sourceCounts ?? []).toSorted((a, b) => a.source.localeCompare(b.source)),
    extraPathCount,
    extraPaths,
    extraPathsTruncated,
    excludePathCount,
    excludePaths,
    excludePathsTruncated,
    cache: status.cache,
    fts: status.fts,
    vector: status.vector,
    fallback: status.fallback,
    providerUnavailableReason,
    readonlyRecovery: readReadonlyRecovery(status),
  };
}

export function isDegradedMemoryStatus(status: MemoryProviderStatus): boolean {
  const searchMode =
    typeof status.custom?.searchMode === "string" ? status.custom.searchMode : undefined;
  return status.provider === "none" || searchMode === "fts-only";
}
