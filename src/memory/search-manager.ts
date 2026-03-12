import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedQmdConfig } from "./backend-config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { shortDiagnosticFingerprint } from "./diagnostics.js";
import type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySyncProgressUpdate,
} from "./types.js";

const log = createSubsystemLogger("memory");
const QMD_MANAGER_CACHE = new Map<string, MemorySearchManager>();
const QMD_MANAGER_PENDING = new Map<string, Promise<MemorySearchManager | null>>();
let qmdCacheGeneration = 0;
let managerRuntimePromise: Promise<typeof import("./manager-runtime.js")> | null = null;

function loadManagerRuntime() {
  managerRuntimePromise ??= import("./manager-runtime.js");
  return managerRuntimePromise;
}

class QmdManagerCacheInvalidatedError extends Error {
  constructor() {
    super("qmd memory manager cache invalidated during config reload");
  }
}

async function awaitFreshQmdManagerAfterInvalidation(
  cacheKey: string,
  stalePromise?: Promise<MemorySearchManager | null>,
): Promise<MemorySearchManager | null> {
  const cacheKeyFingerprint = shortDiagnosticFingerprint(cacheKey);
  const refreshed = QMD_MANAGER_CACHE.get(cacheKey);
  if (refreshed) {
    log.debug("memory search: qmd invalidation recovery found refreshed", {
      cacheKeyFingerprint,
    });
    return refreshed;
  }
  const pending = QMD_MANAGER_PENDING.get(cacheKey);
  if (pending && pending !== stalePromise) {
    log.debug("memory search: qmd invalidation recovery awaiting new pending", {
      cacheKeyFingerprint,
    });
    return await pending;
  }
  throw new QmdManagerCacheInvalidatedError();
}

async function closeDiscardedSearchManager(
  manager: MemorySearchManager | null | undefined,
  context: string,
): Promise<void> {
  try {
    await manager?.close?.();
    log.debug("memory search: discarded manager closed", { context });
  } catch (err) {
    log.warn(`qmd memory manager close failed during ${context}: ${String(err)}`);
  }
}

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

export async function evictAllMemorySearchManagers(): Promise<void> {
  qmdCacheGeneration += 1;
  QMD_MANAGER_PENDING.clear();
  const cachedManagers = [...QMD_MANAGER_CACHE.values()];
  log.info("memory search manager cache eviction", {
    generation: qmdCacheGeneration,
    qmdManagers: cachedManagers.length,
  });
  QMD_MANAGER_CACHE.clear();
  const results = await Promise.allSettled(
    cachedManagers.map(async (manager) => await manager.close?.()),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      log.warn(`qmd memory manager close failed during cache eviction: ${String(result.reason)}`);
    }
  }
  const { evictAllMemoryIndexManagers } = await loadManagerRuntime();
  await evictAllMemoryIndexManagers();
  log.debug("memory search: eviction complete", { generation: qmdCacheGeneration });
}

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemorySearchManagerResult> {
  const resolved = resolveMemoryBackendConfig(params);
  if (resolved.backend === "qmd" && resolved.qmd) {
    const statusOnly = params.purpose === "status";
    let cacheKey: string | undefined;
    let createPromise: Promise<MemorySearchManager | null> | null = null;
    if (!statusOnly) {
      cacheKey = buildQmdCacheKey(params.agentId, resolved.qmd);
      const cacheKeyFingerprint = shortDiagnosticFingerprint(cacheKey);
      const cached = QMD_MANAGER_CACHE.get(cacheKey);
      if (cached) {
        log.debug("memory search: qmd cache hit", {
          agentId: params.agentId,
          cacheKeyFingerprint,
        });
        return { manager: cached };
      }
      const pending = QMD_MANAGER_PENDING.get(cacheKey);
      if (pending) {
        log.debug("memory search: qmd cache wait", {
          agentId: params.agentId,
          cacheKeyFingerprint,
        });
        try {
          return { manager: await pending };
        } catch (err) {
          if (err instanceof QmdManagerCacheInvalidatedError) {
            return { manager: null, error: err.message };
          }
          throw err;
        }
      }
    }
    try {
      const cacheGeneration = qmdCacheGeneration;
      if (!statusOnly && cacheKey) {
        log.debug("memory search: qmd cache miss; creating", {
          agentId: params.agentId,
          cacheKeyFingerprint: shortDiagnosticFingerprint(cacheKey),
          generation: cacheGeneration,
        });
      }
      createPromise = (async (): Promise<MemorySearchManager | null> => {
        const { QmdMemoryManager } = await import("./qmd-manager.js");
        const primary = await QmdMemoryManager.create({
          cfg: params.cfg,
          agentId: params.agentId,
          resolved,
          mode: statusOnly ? "status" : "full",
        });
        if (statusOnly) {
          return primary;
        }
        if (!cacheKey) {
          return primary;
        }
        if (cacheGeneration !== qmdCacheGeneration) {
          log.debug("memory search: qmd generation changed during creation; discarding", {
            agentId: params.agentId,
            cacheKeyFingerprint: shortDiagnosticFingerprint(cacheKey),
          });
          await closeDiscardedSearchManager(primary, "config reload invalidation");
          return await awaitFreshQmdManagerAfterInvalidation(cacheKey, createPromise ?? undefined);
        }
        const refreshed = QMD_MANAGER_CACHE.get(cacheKey);
        if (refreshed) {
          await closeDiscardedSearchManager(primary, "cache refresh handoff");
          return refreshed;
        }
        if (!primary) {
          return null;
        }
        const wrapper = new FallbackMemoryManager(
          {
            primary,
            fallbackFactory: async () => {
              const { MemoryIndexManager } = await loadManagerRuntime();
              return await MemoryIndexManager.get(params);
            },
          },
          () => {
            if (cacheKey) {
              QMD_MANAGER_CACHE.delete(cacheKey);
            }
          },
        );
        if (cacheGeneration !== qmdCacheGeneration) {
          log.debug("memory search: qmd generation changed after wrapping; discarding", {
            agentId: params.agentId,
            cacheKeyFingerprint: shortDiagnosticFingerprint(cacheKey),
          });
          await closeDiscardedSearchManager(wrapper, "config reload invalidation");
          return await awaitFreshQmdManagerAfterInvalidation(cacheKey, createPromise ?? undefined);
        }
        QMD_MANAGER_CACHE.set(cacheKey, wrapper);
        log.debug("memory search: qmd registered", {
          agentId: params.agentId,
          cacheKeyFingerprint: shortDiagnosticFingerprint(cacheKey),
        });
        return wrapper;
      })();
      if (!statusOnly && cacheKey) {
        QMD_MANAGER_PENDING.set(cacheKey, createPromise);
      }
      const manager = await createPromise;
      return { manager };
    } catch (err) {
      if (err instanceof QmdManagerCacheInvalidatedError) {
        return { manager: null, error: err.message };
      }
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`qmd memory unavailable; falling back to builtin: ${message}`);
    } finally {
      if (
        !statusOnly &&
        cacheKey &&
        createPromise &&
        QMD_MANAGER_PENDING.get(cacheKey) === createPromise
      ) {
        QMD_MANAGER_PENDING.delete(cacheKey);
      }
    }
  }

  try {
    log.debug("memory search: using builtin index manager", { agentId: params.agentId });
    const { MemoryIndexManager } = await loadManagerRuntime();
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  const managers = Array.from(QMD_MANAGER_CACHE.values());
  QMD_MANAGER_CACHE.clear();
  for (const manager of managers) {
    try {
      await manager.close?.();
    } catch (err) {
      log.warn(`failed to close qmd memory manager: ${String(err)}`);
    }
  }
  if (managerRuntimePromise !== null) {
    const { closeAllMemoryIndexManagers } = await loadManagerRuntime();
    await closeAllMemoryIndexManagers();
  }
}

class FallbackMemoryManager implements MemorySearchManager {
  private fallback: MemorySearchManager | null = null;
  private primaryFailed = false;
  private lastError?: string;
  private cacheEvicted = false;

  constructor(
    private readonly deps: {
      primary: MemorySearchManager;
      fallbackFactory: () => Promise<MemorySearchManager | null>;
    },
    private readonly onClose?: () => void,
  ) {}

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ) {
    if (!this.primaryFailed) {
      try {
        return await this.deps.primary.search(query, opts);
      } catch (err) {
        this.primaryFailed = true;
        this.lastError = err instanceof Error ? err.message : String(err);
        log.warn(`qmd memory failed; switching to builtin index: ${this.lastError}`);
        await closeDiscardedSearchManager(this.deps.primary, "primary fallback switch");
        // Evict the failed wrapper so the next request can retry QMD with a fresh manager.
        this.evictCacheEntry();
      }
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.search(query, opts);
    }
    throw new Error(this.lastError ?? "memory search unavailable");
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    if (!this.primaryFailed) {
      return await this.deps.primary.readFile(params);
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.readFile(params);
    }
    throw new Error(this.lastError ?? "memory read unavailable");
  }

  status() {
    if (!this.primaryFailed) {
      return this.deps.primary.status();
    }
    const fallbackStatus = this.fallback?.status();
    const fallbackInfo = { from: "qmd", reason: this.lastError ?? "unknown" };
    if (fallbackStatus) {
      const custom = fallbackStatus.custom ?? {};
      return {
        ...fallbackStatus,
        fallback: fallbackInfo,
        custom: {
          ...custom,
          fallback: { disabled: true, reason: this.lastError ?? "unknown" },
        },
      };
    }
    const primaryStatus = this.deps.primary.status();
    const custom = primaryStatus.custom ?? {};
    return {
      ...primaryStatus,
      fallback: fallbackInfo,
      custom: {
        ...custom,
        fallback: { disabled: true, reason: this.lastError ?? "unknown" },
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    if (!this.primaryFailed) {
      await this.deps.primary.sync?.(params);
      return;
    }
    const fallback = await this.ensureFallback();
    await fallback?.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.primaryFailed) {
      return await this.deps.primary.probeEmbeddingAvailability();
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.probeEmbeddingAvailability();
    }
    return { ok: false, error: this.lastError ?? "memory embeddings unavailable" };
  }

  async probeVectorAvailability() {
    if (!this.primaryFailed) {
      return await this.deps.primary.probeVectorAvailability();
    }
    const fallback = await this.ensureFallback();
    return (await fallback?.probeVectorAvailability()) ?? false;
  }

  async close() {
    await this.deps.primary.close?.();
    await this.fallback?.close?.();
    this.evictCacheEntry();
  }

  private async ensureFallback(): Promise<MemorySearchManager | null> {
    if (this.fallback) {
      return this.fallback;
    }
    let fallback: MemorySearchManager | null;
    try {
      fallback = await this.deps.fallbackFactory();
      if (!fallback) {
        log.warn("memory fallback requested but builtin index is unavailable");
        return null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`memory fallback unavailable: ${message}`);
      return null;
    }
    this.fallback = fallback;
    return this.fallback;
  }

  private evictCacheEntry(): void {
    if (this.cacheEvicted) {
      return;
    }
    this.cacheEvicted = true;
    this.onClose?.();
  }
}

function buildQmdCacheKey(agentId: string, config: ResolvedQmdConfig): string {
  // ResolvedQmdConfig is assembled in a stable field order in resolveMemoryBackendConfig.
  // Fast stringify avoids deep key-sorting overhead on this hot path.
  return `${agentId}:${JSON.stringify(config)}`;
}
