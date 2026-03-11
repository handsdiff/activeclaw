import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import chokidar, { FSWatcher } from "chokidar";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { type OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { resolveAgentHistoryConfig } from "../history/config.js";
import { sweepAgentHistoryRetention } from "../history/maintenance.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { resolveUserPath } from "../utils.js";
import {
  describeMemoryReindexReasons,
  shortDiagnosticFingerprint,
  summarizeMemoryIndexMeta,
  summarizeMemoryStatus,
} from "./diagnostics.js";
import { DEFAULT_GEMINI_EMBEDDING_MODEL } from "./embeddings-gemini.js";
import { DEFAULT_MISTRAL_EMBEDDING_MODEL } from "./embeddings-mistral.js";
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from "./embeddings-ollama.js";
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from "./embeddings-openai.js";
import { DEFAULT_VOYAGE_EMBEDDING_MODEL } from "./embeddings-voyage.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OllamaEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embeddings.js";
import { isFileMissingError } from "./fs-utils.js";
import type { HistoryFileEntry } from "./history-files.js";
import { buildHistoryEntry, listHistoryFilesForAgent } from "./history-files.js";
import {
  buildFileEntry,
  ensureDir,
  isExcludedMemoryPath,
  isIndexedTextPath,
  listMemoryFiles,
  normalizeExcludedMemoryPaths,
  normalizeExtraMemoryPaths,
  runWithConcurrency,
} from "./internal.js";
import { type MemoryFileEntry } from "./internal.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import type { SessionFileEntry } from "./session-files.js";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
} from "./session-files.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";
import { requireNodeSqlite } from "./sqlite.js";
import type { MemoryProviderStatus, MemorySource, MemorySyncProgressUpdate } from "./types.js";

type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  sources?: MemorySource[];
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
};

type MemorySyncProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

const META_KEY = "memory_index_meta_v1";
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const SESSION_DIRTY_DEBOUNCE_MS = 5000;
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;
const HISTORY_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

const log = createSubsystemLogger("memory");

function shouldIgnoreMemoryWatchPath(watchPath: string): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized.split(path.sep).map((segment) => segment.trim().toLowerCase());
  return parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment));
}

function summarizePathListForLog(paths: Iterable<string>, max = 8): string[] {
  const entries = Array.from(paths);
  if (entries.length <= max) {
    return entries;
  }
  return [...entries.slice(0, max), `... (+${entries.length - max} more)`];
}

export abstract class MemoryManagerSyncOps {
  protected abstract readonly cfg: OpenClawConfig;
  protected abstract readonly agentId: string;
  protected abstract readonly managerInstanceId: string;
  protected abstract readonly workspaceDir: string;
  protected abstract readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null = null;
  protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama";
  protected openAi?: OpenAiEmbeddingClient;
  protected gemini?: GeminiEmbeddingClient;
  protected voyage?: VoyageEmbeddingClient;
  protected mistral?: MistralEmbeddingClient;
  protected ollama?: OllamaEmbeddingClient;
  protected abstract batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected readonly sources: Set<MemorySource> = new Set();
  protected providerKey: string | null = null;
  protected abstract readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  } = { enabled: false, available: false };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  protected historyWatcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected sessionWatchTimer: NodeJS.Timeout | null = null;
  protected sessionUnsubscribe: (() => void) | null = null;
  protected fallbackReason?: string;
  protected intervalTimer: NodeJS.Timeout | null = null;
  protected historyMaintenanceTimer: NodeJS.Timeout | null = null;
  protected closed = false;
  protected dirty = false;
  protected historyDirty = false;
  protected sessionsDirty = false;
  protected sessionsDirtyFiles = new Set<string>();
  protected sessionPendingFiles = new Set<string>();
  protected sessionDeltas = new Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number }
  >();
  protected providerUnavailableReason?: string;
  private lastMetaSerialized: string | null = null;
  private historyRetentionSweepInFlight: Promise<void> | null = null;

  protected abstract readonly cache: { enabled: boolean; maxEntries?: number };
  protected abstract db: DatabaseSync;
  protected abstract computeProviderKey(): string;
  protected abstract sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  protected abstract status(): MemoryProviderStatus;
  protected abstract withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T>;
  protected abstract getIndexConcurrency(): number;
  protected abstract pruneEmbeddingCacheIfNeeded(): void;
  protected abstract indexFile(
    entry: MemoryFileEntry | SessionFileEntry | HistoryFileEntry,
    options: { source: MemorySource; content?: string },
  ): Promise<void>;
  protected onSafeReindexBuildStart(_params: {
    originalDb: DatabaseSync;
    originalProvider: EmbeddingProvider | null;
    originalProviderUnavailableReason?: string;
    originalFtsAvailable: boolean;
    originalVectorAvailable: boolean | null;
    originalVectorDims?: number;
    originalVectorReady: Promise<boolean> | null;
  }): void {}
  protected onSafeReindexPromoteStart(): Promise<void> | void {}
  protected onSafeReindexFinished(): void {}

  protected buildMemoryLogMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      agentId: this.agentId,
      managerId: this.managerInstanceId,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      sources: Array.from(this.sources),
      ...extra,
    };
  }

  protected buildMemoryDiagnostics(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return this.buildMemoryLogMeta({
      requestedProvider: this.settings.provider,
      provider: this.provider?.id ?? "none",
      model: this.provider?.model,
      settingsFingerprint: shortDiagnosticFingerprint(JSON.stringify(this.settings)),
      providerKeyFingerprint: this.providerKey
        ? shortDiagnosticFingerprint(this.providerKey)
        : undefined,
      providerUnavailableReason: this.providerUnavailableReason,
      extraPaths: summarizePathListForLog(this.settings.extraPaths),
      extraPathsCount: this.settings.extraPaths.length,
      excludePaths: summarizePathListForLog(this.settings.excludePaths),
      excludePathsCount: this.settings.excludePaths.length,
      hasRemoteBaseUrl: Boolean(this.settings.remote?.baseUrl),
      hasRemoteApiKey: Boolean(this.settings.remote?.apiKey),
      hasRemoteHeaders: Boolean(
        this.settings.remote?.headers && Object.keys(this.settings.remote.headers).length > 0,
      ),
      watchEnabled: this.settings.sync.watch,
      watchDebounceMs: this.settings.sync.watchDebounceMs,
      intervalMinutes: this.settings.sync.intervalMinutes,
      sessionDeltaBytes: this.settings.sync.sessions.deltaBytes,
      sessionDeltaMessages: this.settings.sync.sessions.deltaMessages,
      ...extra,
    });
  }

  protected deleteIndexedPathRows(
    pathValue: string,
    source: MemorySource,
    options?: { deleteFile?: boolean },
  ): void {
    if (options?.deleteFile !== false) {
      this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(pathValue, source);
    }
    try {
      this.db
        .prepare(
          `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
        )
        .run(pathValue, source);
    } catch {}
    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(pathValue, source);
    try {
      this.db
        .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ?`)
        .run(pathValue, source);
    } catch {}
  }

  protected async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    if (!this.vectorReady) {
      this.vectorReady = this.withTimeout(
        this.loadVectorExtension(),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    let ready = false;
    try {
      ready = (await this.vectorReady) || false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      this.vectorReady = null;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.vector.available !== null) {
      return this.vector.available;
    }
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      const resolvedPath = this.vector.extensionPath?.trim()
        ? resolveUserPath(this.vector.extensionPath)
        : undefined;
      const loaded = await loadSqliteVecExtension({ db: this.db, extensionPath: resolvedPath });
      if (!loaded.ok) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }
      this.vector.extensionPath = loaded.extensionPath;
      this.vector.available = true;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  private ensureVectorTable(dimensions: number): void {
    if (this.vector.dims === dimensions) {
      return;
    }
    if (this.vector.dims && this.vector.dims !== dimensions) {
      this.dropVectorTable();
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.vector.dims = dimensions;
  }

  private dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
    }
  }

  protected buildSourceFilter(alias?: string): { sql: string; params: MemorySource[] } {
    const sources = Array.from(this.sources);
    if (sources.length === 0) {
      return { sql: "", params: [] };
    }
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  protected openDatabase(): DatabaseSync {
    const dbPath = resolveUserPath(this.settings.store.path);
    return this.openDatabaseAtPath(dbPath);
  }

  private openDatabaseAtPath(dbPath: string): DatabaseSync {
    const dir = path.dirname(dbPath);
    ensureDir(dir);
    const { DatabaseSync } = requireNodeSqlite();
    return new DatabaseSync(dbPath, { allowExtension: this.settings.store.vector.enabled });
  }

  private seedEmbeddingCache(sourceDb: DatabaseSync): void {
    if (!this.cache.enabled) {
      return;
    }
    try {
      const rows = sourceDb
        .prepare(
          `SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE}`,
        )
        .all() as Array<{
        provider: string;
        model: string;
        provider_key: string;
        hash: string;
        embedding: string;
        dims: number | null;
        updated_at: number;
      }>;
      if (!rows.length) {
        return;
      }
      const insert = this.db.prepare(
        `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
           embedding=excluded.embedding,
           dims=excluded.dims,
           updated_at=excluded.updated_at`,
      );
      this.db.exec("BEGIN");
      for (const row of rows) {
        insert.run(
          row.provider,
          row.model,
          row.provider_key,
          row.hash,
          row.embedding,
          row.dims,
          row.updated_at,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  private async swapIndexFiles(targetPath: string, tempPath: string): Promise<void> {
    const backupPath = `${targetPath}.backup-${randomUUID()}`;
    await this.moveIndexFiles(targetPath, backupPath);
    try {
      await this.moveIndexFiles(tempPath, targetPath);
    } catch (err) {
      await this.moveIndexFiles(backupPath, targetPath);
      throw err;
    }
    await this.removeIndexFiles(backupPath);
  }

  private async moveIndexFiles(sourceBase: string, targetBase: string): Promise<void> {
    const suffixes = ["", "-wal", "-shm"];
    for (const suffix of suffixes) {
      const source = `${sourceBase}${suffix}`;
      const target = `${targetBase}${suffix}`;
      try {
        await fs.rename(source, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }
  }

  private async removeIndexFiles(basePath: string): Promise<void> {
    const suffixes = ["", "-wal", "-shm"];
    await Promise.all(suffixes.map((suffix) => fs.rm(`${basePath}${suffix}`, { force: true })));
  }

  protected ensureSchema() {
    const result = ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
    });
    this.fts.available = result.ftsAvailable;
    if (result.ftsError) {
      this.fts.loadError = result.ftsError;
      // Only warn when hybrid search is enabled; otherwise this is expected noise.
      if (this.fts.enabled) {
        log.warn(`fts unavailable: ${result.ftsError}`);
      }
    }
  }

  protected ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.watcher) {
      return;
    }
    const excludedPaths = normalizeExcludedMemoryPaths(
      this.workspaceDir,
      this.settings.excludePaths,
    );
    const watchPaths = new Set<string>([
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory.md"),
      path.join(this.workspaceDir, "memory"),
    ]);
    const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
    for (const entry of additionalPaths) {
      if (isExcludedMemoryPath(entry, excludedPaths)) {
        continue;
      }
      try {
        const stat = fsSync.lstatSync(entry);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          watchPaths.add(entry);
          continue;
        }
        if (stat.isFile()) {
          watchPaths.add(entry);
        }
      } catch {
        // Skip missing/unreadable additional paths.
      }
    }
    const watchRoots = new Set(Array.from(watchPaths).map((entry) => path.resolve(entry)));
    this.watcher = chokidar.watch(Array.from(watchPaths), {
      ignoreInitial: true,
      ignored: (watchPath, stats) => {
        const normalized = path.normalize(String(watchPath));
        const resolved = path.resolve(normalized);
        if (watchRoots.has(resolved)) {
          return false;
        }
        if (isExcludedMemoryPath(resolved, excludedPaths)) {
          return true;
        }
        if (shouldIgnoreMemoryWatchPath(normalized)) {
          return true;
        }
        const stat = (() => {
          if (stats) {
            return stats;
          }
          try {
            return fsSync.lstatSync(normalized);
          } catch {
            return null;
          }
        })();
        if (stat?.isSymbolicLink?.()) {
          return true;
        }
        if (stat?.isDirectory?.()) {
          return false;
        }
        return !isIndexedTextPath(normalized);
      },
      awaitWriteFinish: {
        stabilityThreshold: this.settings.sync.watchDebounceMs,
        pollInterval: 100,
      },
    });
    log.debug(
      "memory watcher started",
      this.buildMemoryLogMeta({
        watchPaths: summarizePathListForLog(watchPaths),
        watchRoots: summarizePathListForLog(watchRoots),
        excludePaths: summarizePathListForLog(excludedPaths),
      }),
    );
    const markDirty = () => {
      this.dirty = true;
      this.scheduleWatchSync();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
    this.watcher.on("error", (err) => {
      log.warn("memory watcher error", this.buildMemoryLogMeta({ err: String(err) }));
    });
  }

  protected ensureHistoryWatcher() {
    if (!this.sources.has("history") || !this.settings.sync.watch || this.historyWatcher) {
      return;
    }
    const history = resolveAgentHistoryConfig(this.cfg, this.agentId);
    if (!history.enabled) {
      return;
    }
    this.historyWatcher = chokidar.watch(history.path, {
      ignoreInitial: true,
      ignored: (watchPath, stats) => {
        const normalized = path.normalize(String(watchPath));
        const stat = (() => {
          if (stats) {
            return stats;
          }
          try {
            return fsSync.lstatSync(normalized);
          } catch {
            return null;
          }
        })();
        if (stat?.isSymbolicLink?.()) {
          return true;
        }
        if (stat?.isDirectory?.()) {
          return false;
        }
        return !isIndexedTextPath(normalized);
      },
      awaitWriteFinish: {
        stabilityThreshold: this.settings.sync.watchDebounceMs,
        pollInterval: 100,
      },
    });
    log.debug(
      "history watcher started",
      this.buildMemoryLogMeta({
        historyPath: history.path,
      }),
    );
    const markDirty = () => {
      this.historyDirty = true;
      this.scheduleWatchSync();
    };
    this.historyWatcher.on("add", markDirty);
    this.historyWatcher.on("change", markDirty);
    this.historyWatcher.on("unlink", markDirty);
    this.historyWatcher.on("error", (err) => {
      log.warn("history watcher error", this.buildMemoryLogMeta({ err: String(err) }));
    });
  }

  protected ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      if (this.closed) {
        return;
      }
      const sessionFile = update.sessionFile;
      if (!this.isSessionFileForAgent(sessionFile)) {
        return;
      }
      this.scheduleSessionDirty(sessionFile);
    });
    log.debug(
      "memory session listener started",
      this.buildMemoryLogMeta({
        sessionsPath: resolveSessionTranscriptsDirForAgent(this.agentId),
        sessionDeltaBytes: this.settings.sync.sessions.deltaBytes,
        sessionDeltaMessages: this.settings.sync.sessions.deltaMessages,
      }),
    );
  }

  private scheduleSessionDirty(sessionFile: string) {
    this.sessionPendingFiles.add(sessionFile);
    if (this.sessionWatchTimer) {
      return;
    }
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null;
      void this.processSessionDeltaBatch().catch((err) => {
        log.warn(`memory session delta failed: ${String(err)}`);
      });
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  private async processSessionDeltaBatch(): Promise<void> {
    if (this.sessionPendingFiles.size === 0) {
      return;
    }
    const pending = Array.from(this.sessionPendingFiles);
    this.sessionPendingFiles.clear();
    let shouldSync = false;
    for (const sessionFile of pending) {
      const delta = await this.updateSessionDelta(sessionFile);
      if (!delta) {
        continue;
      }
      const bytesThreshold = delta.deltaBytes;
      const messagesThreshold = delta.deltaMessages;
      const bytesHit =
        bytesThreshold <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= bytesThreshold;
      const messagesHit =
        messagesThreshold <= 0
          ? delta.pendingMessages > 0
          : delta.pendingMessages >= messagesThreshold;
      if (!bytesHit && !messagesHit) {
        continue;
      }
      this.sessionsDirtyFiles.add(sessionFile);
      this.sessionsDirty = true;
      delta.pendingBytes =
        bytesThreshold > 0 ? Math.max(0, delta.pendingBytes - bytesThreshold) : 0;
      delta.pendingMessages =
        messagesThreshold > 0 ? Math.max(0, delta.pendingMessages - messagesThreshold) : 0;
      shouldSync = true;
    }
    if (shouldSync) {
      void this.sync({ reason: "session-delta" }).catch((err) => {
        log.warn(`memory sync failed (session-delta): ${String(err)}`);
      });
    }
  }

  private async updateSessionDelta(sessionFile: string): Promise<{
    deltaBytes: number;
    deltaMessages: number;
    pendingBytes: number;
    pendingMessages: number;
  } | null> {
    const thresholds = this.settings.sync.sessions;
    if (!thresholds) {
      return null;
    }
    let stat: { size: number };
    try {
      stat = await fs.stat(sessionFile);
    } catch {
      return null;
    }
    const size = stat.size;
    let state = this.sessionDeltas.get(sessionFile);
    if (!state) {
      state = { lastSize: 0, pendingBytes: 0, pendingMessages: 0 };
      this.sessionDeltas.set(sessionFile, state);
    }
    const deltaBytes = Math.max(0, size - state.lastSize);
    if (deltaBytes === 0 && size === state.lastSize) {
      return {
        deltaBytes: thresholds.deltaBytes,
        deltaMessages: thresholds.deltaMessages,
        pendingBytes: state.pendingBytes,
        pendingMessages: state.pendingMessages,
      };
    }
    if (size < state.lastSize) {
      state.lastSize = size;
      state.pendingBytes += size;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, 0, size);
      }
    } else {
      state.pendingBytes += deltaBytes;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, state.lastSize, size);
      }
      state.lastSize = size;
    }
    this.sessionDeltas.set(sessionFile, state);
    return {
      deltaBytes: thresholds.deltaBytes,
      deltaMessages: thresholds.deltaMessages,
      pendingBytes: state.pendingBytes,
      pendingMessages: state.pendingMessages,
    };
  }

  private async countNewlines(absPath: string, start: number, end: number): Promise<number> {
    if (end <= start) {
      return 0;
    }
    let handle;
    try {
      handle = await fs.open(absPath, "r");
    } catch (err) {
      if (isFileMissingError(err)) {
        return 0;
      }
      throw err;
    }
    try {
      let offset = start;
      let count = 0;
      const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES);
      while (offset < end) {
        const toRead = Math.min(buffer.length, end - offset);
        const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
        if (bytesRead <= 0) {
          break;
        }
        for (let i = 0; i < bytesRead; i += 1) {
          if (buffer[i] === 10) {
            count += 1;
          }
        }
        offset += bytesRead;
      }
      return count;
    } finally {
      await handle.close();
    }
  }

  private resetSessionDelta(absPath: string, size: number): void {
    const state = this.sessionDeltas.get(absPath);
    if (!state) {
      return;
    }
    state.lastSize = size;
    state.pendingBytes = 0;
    state.pendingMessages = 0;
  }

  private isSessionFileForAgent(sessionFile: string): boolean {
    if (!sessionFile) {
      return false;
    }
    const sessionsDir = resolveSessionTranscriptsDirForAgent(this.agentId);
    const resolvedFile = path.resolve(sessionFile);
    const resolvedDir = path.resolve(sessionsDir);
    return resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
  }

  protected ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      void this.sync({ reason: "interval" }).catch((err) => {
        log.warn(`memory sync failed (interval): ${String(err)}`);
      });
    }, ms);
    log.debug(
      "memory interval sync started",
      this.buildMemoryLogMeta({ intervalMinutes: minutes, intervalMs: ms }),
    );
  }

  protected ensureHistoryMaintenance() {
    if (this.historyMaintenanceTimer) {
      return;
    }
    const history = resolveAgentHistoryConfig(this.cfg, this.agentId);
    if (!history.enabled || history.retention.days == null) {
      return;
    }
    this.historyMaintenanceTimer = setInterval(() => {
      void this.runHistoryRetentionSweep().catch((err) => {
        log.warn(`history retention sweep failed for ${this.agentId}`, { err: String(err) });
      });
    }, HISTORY_RETENTION_SWEEP_INTERVAL_MS);
    log.debug(
      "history retention maintenance started",
      this.buildMemoryLogMeta({
        historyPath: history.path,
        retentionDays: history.retention.days,
        sweepIntervalMs: HISTORY_RETENTION_SWEEP_INTERVAL_MS,
      }),
    );
  }

  protected async runHistoryRetentionSweep(): Promise<void> {
    if (this.closed) {
      return;
    }
    const existing = this.historyRetentionSweepInFlight;
    if (existing) {
      return await existing;
    }
    const task = (async () => {
      await sweepAgentHistoryRetention({
        cfg: this.cfg,
        agentId: this.agentId,
      });
    })().finally(() => {
      if (this.historyRetentionSweepInFlight === task) {
        this.historyRetentionSweepInFlight = null;
      }
    });
    this.historyRetentionSweepInFlight = task;
    await task;
  }

  private scheduleWatchSync() {
    if (!this.settings.sync.watch) {
      return;
    }
    if (!this.sources.has("memory") && !this.sources.has("history")) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        log.warn(`memory sync failed (watch): ${String(err)}`);
      });
    }, this.settings.sync.watchDebounceMs);
  }

  private shouldSyncSessions(
    params?: { reason?: string; force?: boolean },
    needsFullReindex = false,
  ) {
    if (!this.sources.has("sessions")) {
      return false;
    }
    if (params?.force) {
      return true;
    }
    if (needsFullReindex) {
      return true;
    }
    const reason = params?.reason;
    if (reason === "session-start" || reason === "watch") {
      return false;
    }
    return this.sessionsDirty && this.sessionsDirtyFiles.size > 0;
  }

  private async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    const files = await listMemoryFiles(
      this.workspaceDir,
      this.settings.extraPaths,
      this.settings.excludePaths,
    );
    const fileEntries = (
      await Promise.all(files.map(async (file) => buildFileEntry(file, this.workspaceDir)))
    ).filter((entry): entry is MemoryFileEntry => entry !== null);
    log.debug("memory sync: indexing memory files", {
      files: fileEntries.length,
      needsFullReindex: params.needsFullReindex,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
      mode: this.provider ? "hybrid" : "fts-only",
    });
    const activePaths = new Set(fileEntries.map((entry) => entry.path));
    if (params.progress) {
      params.progress.total += fileEntries.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing memory files (batch)..." : "Indexing memory files…",
      });
    }

    const tasks = fileEntries.map((entry) => async () => {
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "memory") as { hash: string } | undefined;
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      await this.indexFile(entry, { source: "memory" });
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("memory") as Array<{ path: string }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      this.deleteIndexedPathRows(stale.path, "memory");
    }
  }

  private async syncSessionFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    const files = await listSessionFilesForAgent(this.agentId);
    const activePaths = new Set(files.map((file) => sessionPathForFile(file)));
    const indexAll = params.needsFullReindex || this.sessionsDirtyFiles.size === 0;
    log.debug("memory sync: indexing session files", {
      files: files.length,
      indexAll,
      dirtyFiles: this.sessionsDirtyFiles.size,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
      mode: this.provider ? "hybrid" : "fts-only",
    });
    if (params.progress) {
      params.progress.total += files.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing session files (batch)..." : "Indexing session files…",
      });
    }

    const tasks = files.map((absPath) => async () => {
      if (!indexAll && !this.sessionsDirtyFiles.has(absPath)) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      const entry = await buildSessionEntry(absPath);
      if (!entry) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "sessions") as { hash: string } | undefined;
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        this.resetSessionDelta(absPath, entry.size);
        return;
      }
      await this.indexFile(entry, { source: "sessions", content: entry.content });
      this.resetSessionDelta(absPath, entry.size);
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("sessions") as Array<{ path: string }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      this.deleteIndexedPathRows(stale.path, "sessions");
    }
  }

  private async syncHistoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    const files = await listHistoryFilesForAgent(this.cfg, this.agentId);
    const historyRoot = resolveAgentHistoryConfig(this.cfg, this.agentId).path;
    const activePaths = new Set(
      files.map((file) =>
        path.join("history", path.relative(historyRoot, file)).replace(/\\/g, "/"),
      ),
    );
    log.debug("memory sync: indexing history files", {
      files: files.length,
      needsFullReindex: params.needsFullReindex,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
      mode: this.provider ? "hybrid" : "fts-only",
    });
    if (params.progress) {
      params.progress.total += files.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing history files (batch)..." : "Indexing history files…",
      });
    }

    const tasks = files.map((absPath) => async () => {
      const entry = await buildHistoryEntry(absPath, this.cfg, this.agentId);
      if (!entry) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "history") as { hash: string } | undefined;
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      await this.indexFile(entry, { source: "history", content: entry.content });
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("history") as Array<{ path: string }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      this.deleteIndexedPathRows(stale.path, "history");
    }
  }

  private createSyncProgress(
    onProgress: (update: MemorySyncProgressUpdate) => void,
  ): MemorySyncProgressState {
    const state: MemorySyncProgressState = {
      completed: 0,
      total: 0,
      label: undefined,
      report: (update) => {
        if (update.label) {
          state.label = update.label;
        }
        const label =
          update.total > 0 && state.label
            ? `${state.label} ${update.completed}/${update.total}`
            : state.label;
        onProgress({
          completed: update.completed,
          total: update.total,
          label,
        });
      },
    };
    return state;
  }

  protected async runSync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    if (progress) {
      progress.report({
        completed: progress.completed,
        total: progress.total,
        label: "Loading vector extension…",
      });
    }
    const vectorReady = await this.ensureVectorReady();
    const meta = this.readMeta();
    const configuredSources = this.resolveConfiguredSourcesForMeta();
    const reindexReasons = describeMemoryReindexReasons({
      force: params?.force,
      meta,
      providerId: this.provider?.id ?? null,
      providerModel: this.provider?.model ?? null,
      providerKey: this.providerKey,
      configuredSources,
      settings: this.settings,
      vectorReady,
    });
    const needsFullReindex = reindexReasons.length > 0;
    if (needsFullReindex) {
      log.info(
        "memory sync: full reindex required",
        this.buildMemoryLogMeta({
          trigger: params?.reason ?? "unspecified",
          force: Boolean(params?.force),
          vectorReady,
          currentMeta: summarizeMemoryIndexMeta(meta),
          configuredSources,
          reindexReasons,
        }),
      );
    }
    try {
      if (needsFullReindex) {
        if (
          process.env.OPENCLAW_TEST_FAST === "1" &&
          process.env.OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX === "1"
        ) {
          await this.runUnsafeReindex({
            reason: params?.reason,
            force: params?.force,
            progress: progress ?? undefined,
            reindexReasons,
          });
        } else {
          await this.runSafeReindex({
            reason: params?.reason,
            force: params?.force,
            progress: progress ?? undefined,
            reindexReasons,
          });
        }
        return;
      }

      const shouldSyncMemory =
        this.sources.has("memory") && (params?.force || needsFullReindex || this.dirty);
      const shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);
      const shouldSyncHistory =
        this.sources.has("history") && (params?.force || needsFullReindex || this.historyDirty);

      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex, progress: progress ?? undefined });
        this.dirty = false;
      }

      if (shouldSyncSessions) {
        await this.syncSessionFiles({ needsFullReindex, progress: progress ?? undefined });
        this.sessionsDirty = false;
        this.sessionsDirtyFiles.clear();
      } else if (this.sessionsDirtyFiles.size > 0) {
        this.sessionsDirty = true;
      } else {
        this.sessionsDirty = false;
      }

      if (shouldSyncHistory) {
        await this.syncHistoryFiles({ needsFullReindex, progress: progress ?? undefined });
        this.historyDirty = false;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const activated =
        this.shouldFallbackOnError(reason) && (await this.activateFallbackProvider(reason));
      if (activated) {
        await this.runSafeReindex({
          reason: params?.reason ?? "fallback",
          force: true,
          progress: progress ?? undefined,
          reindexReasons: [`fallback:${reason}`],
          snapshotProvider: null,
          snapshotProviderUnavailableReason: `keyword-only snapshot during fallback reindex: ${reason}`,
        });
        return;
      }
      throw err;
    }
  }

  private shouldFallbackOnError(message: string): boolean {
    return /embedding|embeddings|batch/i.test(message);
  }

  protected resolveBatchConfig(): {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  } {
    const batch = this.settings.remote?.batch;
    const enabled = Boolean(
      batch?.enabled &&
      this.provider &&
      ((this.openAi && this.provider.id === "openai") ||
        (this.gemini && this.provider.id === "gemini") ||
        (this.voyage && this.provider.id === "voyage")),
    );
    return {
      enabled,
      wait: batch?.wait ?? true,
      concurrency: Math.max(1, batch?.concurrency ?? 2),
      pollIntervalMs: batch?.pollIntervalMs ?? 2000,
      timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1000,
    };
  }

  private async activateFallbackProvider(reason: string): Promise<boolean> {
    const fallback = this.settings.fallback;
    if (!fallback || fallback === "none" || !this.provider || fallback === this.provider.id) {
      return false;
    }
    if (this.fallbackFrom) {
      return false;
    }
    const fallbackFrom = this.provider.id as
      | "openai"
      | "gemini"
      | "local"
      | "voyage"
      | "mistral"
      | "ollama";

    const fallbackModel =
      fallback === "gemini"
        ? DEFAULT_GEMINI_EMBEDDING_MODEL
        : fallback === "openai"
          ? DEFAULT_OPENAI_EMBEDDING_MODEL
          : fallback === "voyage"
            ? DEFAULT_VOYAGE_EMBEDDING_MODEL
            : fallback === "mistral"
              ? DEFAULT_MISTRAL_EMBEDDING_MODEL
              : fallback === "ollama"
                ? DEFAULT_OLLAMA_EMBEDDING_MODEL
                : this.settings.model;

    const fallbackResult = await createEmbeddingProvider({
      config: this.cfg,
      agentDir: resolveAgentDir(this.cfg, this.agentId),
      provider: fallback,
      remote: this.settings.remote,
      model: fallbackModel,
      fallback: "none",
      local: this.settings.local,
    });

    this.fallbackFrom = fallbackFrom;
    this.fallbackReason = reason;
    this.provider = fallbackResult.provider;
    this.openAi = fallbackResult.openAi;
    this.gemini = fallbackResult.gemini;
    this.voyage = fallbackResult.voyage;
    this.mistral = fallbackResult.mistral;
    this.ollama = fallbackResult.ollama;
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    log.warn(`memory embeddings: switched to fallback provider (${fallback})`, {
      ...this.buildMemoryDiagnostics(),
      from: fallbackFrom,
      to: fallback,
      reason,
    });
    return true;
  }

  private async runSafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
    reindexReasons?: string[];
    snapshotProvider?: EmbeddingProvider | null;
    snapshotProviderUnavailableReason?: string;
  }): Promise<void> {
    const dbPath = resolveUserPath(this.settings.store.path);
    const tempDbPath = `${dbPath}.tmp-${randomUUID()}`;
    const tempDb = this.openDatabaseAtPath(tempDbPath);

    const originalDb = this.db;
    let originalDbClosed = false;
    const originalState = {
      ftsAvailable: this.fts.available,
      ftsError: this.fts.loadError,
      vectorAvailable: this.vector.available,
      vectorLoadError: this.vector.loadError,
      vectorDims: this.vector.dims,
      vectorReady: this.vectorReady,
    };

    const restoreOriginalState = () => {
      if (originalDbClosed) {
        this.db = this.openDatabaseAtPath(dbPath);
      } else {
        this.db = originalDb;
      }
      this.fts.available = originalState.ftsAvailable;
      this.fts.loadError = originalState.ftsError;
      this.vector.available = originalDbClosed ? null : originalState.vectorAvailable;
      this.vector.loadError = originalState.vectorLoadError;
      this.vector.dims = originalState.vectorDims;
      this.vectorReady = originalDbClosed ? null : originalState.vectorReady;
    };

    const hasSnapshotProvider = Object.prototype.hasOwnProperty.call(params, "snapshotProvider");
    log.info("memory sync: starting safe reindex", {
      ...this.buildMemoryDiagnostics(),
      trigger: params.reason ?? "unspecified",
      force: Boolean(params.force),
      dbPath,
      tempDbFingerprint: shortDiagnosticFingerprint(tempDbPath),
      reindexReasons: params.reindexReasons ?? [],
      snapshotProvider: hasSnapshotProvider ? (params.snapshotProvider?.id ?? "none") : undefined,
      snapshotProviderUnavailableReason: params.snapshotProviderUnavailableReason,
    });
    this.onSafeReindexBuildStart({
      originalDb,
      originalProvider: hasSnapshotProvider ? (params.snapshotProvider ?? null) : this.provider,
      originalProviderUnavailableReason:
        params.snapshotProviderUnavailableReason ?? this.providerUnavailableReason,
      originalFtsAvailable: originalState.ftsAvailable,
      originalVectorAvailable: originalState.vectorAvailable,
      originalVectorDims: originalState.vectorDims,
      originalVectorReady: originalState.vectorReady,
    });
    this.db = tempDb;
    this.vectorReady = null;
    this.vector.available = null;
    this.vector.loadError = undefined;
    this.vector.dims = undefined;
    this.fts.available = false;
    this.fts.loadError = undefined;
    this.ensureSchema();

    let nextMeta: MemoryIndexMeta | null = null;

    try {
      this.seedEmbeddingCache(originalDb);
      const shouldSyncMemory = this.sources.has("memory");
      const shouldSyncSessions = this.shouldSyncSessions(
        { reason: params.reason, force: params.force },
        true,
      );
      const shouldSyncHistory = this.sources.has("history");

      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
        this.dirty = false;
      }

      if (shouldSyncSessions) {
        await this.syncSessionFiles({ needsFullReindex: true, progress: params.progress });
        this.sessionsDirty = false;
        this.sessionsDirtyFiles.clear();
      } else if (this.sessionsDirtyFiles.size > 0) {
        this.sessionsDirty = true;
      } else {
        this.sessionsDirty = false;
      }

      if (shouldSyncHistory) {
        await this.syncHistoryFiles({ needsFullReindex: true, progress: params.progress });
        this.historyDirty = false;
      }

      nextMeta = {
        model: this.provider?.model ?? "fts-only",
        provider: this.provider?.id ?? "none",
        providerKey: this.providerKey!,
        sources: this.resolveConfiguredSourcesForMeta(),
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
      };
      if (!nextMeta) {
        throw new Error("Failed to compute memory index metadata for reindexing.");
      }

      if (this.vector.available && this.vector.dims) {
        nextMeta.vectorDims = this.vector.dims;
      }

      this.writeMeta(nextMeta);
      this.pruneEmbeddingCacheIfNeeded?.();

      await this.onSafeReindexPromoteStart();
      this.db.close();
      originalDb.close();
      originalDbClosed = true;

      await this.swapIndexFiles(dbPath, tempDbPath);

      this.db = this.openDatabaseAtPath(dbPath);
      this.vectorReady = null;
      this.vector.available = null;
      this.vector.loadError = undefined;
      this.ensureSchema();
      this.vector.dims = nextMeta?.vectorDims;
      log.info("memory sync: safe reindex promoted", {
        ...this.buildMemoryDiagnostics(),
        trigger: params.reason ?? "unspecified",
        reindexReasons: params.reindexReasons ?? [],
        meta: summarizeMemoryIndexMeta(nextMeta),
        status: summarizeMemoryStatus(this.status()),
      });
      this.onSafeReindexFinished();
    } catch (err) {
      try {
        this.db.close();
      } catch {}
      await this.removeIndexFiles(tempDbPath);
      restoreOriginalState();
      log.warn("memory sync: safe reindex failed", {
        ...this.buildMemoryDiagnostics(),
        trigger: params.reason ?? "unspecified",
        reindexReasons: params.reindexReasons ?? [],
        error: err instanceof Error ? err.message : String(err),
        tempDbFingerprint: shortDiagnosticFingerprint(tempDbPath),
      });
      this.onSafeReindexFinished();
      throw err;
    }
  }

  private async runUnsafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
    reindexReasons?: string[];
  }): Promise<void> {
    // Perf: for test runs, skip atomic temp-db swapping. The index is isolated
    // under the per-test HOME anyway, and this cuts substantial fs+sqlite churn.
    log.info("memory sync: starting unsafe reindex", {
      ...this.buildMemoryDiagnostics(),
      trigger: params.reason ?? "unspecified",
      force: Boolean(params.force),
      reindexReasons: params.reindexReasons ?? [],
    });
    this.resetIndex();

    const shouldSyncMemory = this.sources.has("memory");
    const shouldSyncSessions = this.shouldSyncSessions(
      { reason: params.reason, force: params.force },
      true,
    );
    const shouldSyncHistory = this.sources.has("history");

    if (shouldSyncMemory) {
      await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
      this.dirty = false;
    }

    if (shouldSyncSessions) {
      await this.syncSessionFiles({ needsFullReindex: true, progress: params.progress });
      this.sessionsDirty = false;
      this.sessionsDirtyFiles.clear();
    } else if (this.sessionsDirtyFiles.size > 0) {
      this.sessionsDirty = true;
    } else {
      this.sessionsDirty = false;
    }

    if (shouldSyncHistory) {
      await this.syncHistoryFiles({ needsFullReindex: true, progress: params.progress });
      this.historyDirty = false;
    }

    const nextMeta: MemoryIndexMeta = {
      model: this.provider?.model ?? "fts-only",
      provider: this.provider?.id ?? "none",
      providerKey: this.providerKey!,
      sources: this.resolveConfiguredSourcesForMeta(),
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
    };
    if (this.vector.available && this.vector.dims) {
      nextMeta.vectorDims = this.vector.dims;
    }

    this.writeMeta(nextMeta);
    this.pruneEmbeddingCacheIfNeeded?.();
    log.info("memory sync: unsafe reindex complete", {
      ...this.buildMemoryDiagnostics(),
      trigger: params.reason ?? "unspecified",
      reindexReasons: params.reindexReasons ?? [],
      meta: summarizeMemoryIndexMeta(nextMeta),
      status: summarizeMemoryStatus(this.status()),
    });
  }

  private resetIndex() {
    this.db.exec(`DELETE FROM files`);
    this.db.exec(`DELETE FROM chunks`);
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db.exec(`DELETE FROM ${FTS_TABLE}`);
      } catch {}
    }
    this.dropVectorTable();
    this.vector.dims = undefined;
    this.sessionsDirtyFiles.clear();
  }

  protected readMeta(): MemoryIndexMeta | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) {
      this.lastMetaSerialized = null;
      return null;
    }
    try {
      const parsed = JSON.parse(row.value) as MemoryIndexMeta;
      this.lastMetaSerialized = row.value;
      return parsed;
    } catch (err) {
      this.lastMetaSerialized = null;
      log.warn("memory sync: index meta unreadable; treating as missing", {
        ...this.buildMemoryDiagnostics(),
        error: err instanceof Error ? err.message : String(err),
        metaFingerprint: shortDiagnosticFingerprint(row.value),
        metaBytes: row.value.length,
      });
      return null;
    }
  }

  protected writeMeta(meta: MemoryIndexMeta) {
    const value = JSON.stringify(meta);
    if (this.lastMetaSerialized === value) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, value);
    this.lastMetaSerialized = value;
    log.info("memory sync: wrote index meta", {
      ...this.buildMemoryDiagnostics(),
      meta: summarizeMemoryIndexMeta(meta),
    });
  }

  private resolveConfiguredSourcesForMeta(): MemorySource[] {
    const normalized = Array.from(this.sources)
      .filter(
        (source): source is MemorySource =>
          source === "memory" || source === "sessions" || source === "history",
      )
      .toSorted();
    return normalized.length > 0 ? normalized : ["memory"];
  }
}
