import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from "./embeddings-ollama.js";
import type { MemoryIndexManager } from "./index.js";
import { createOpenAIEmbeddingProviderMock } from "./test-embeddings-mock.js";
import { createMemoryManagerOrThrow } from "./test-manager.js";

const { createEmbeddingProviderMock } = vi.hoisted(() => ({
  createEmbeddingProviderMock: vi.fn(),
}));

const embedBatch = vi.fn(async (_input: string[]): Promise<number[][]> => []);
const embedQuery = vi.fn(async (_input: string): Promise<number[]> => [0.2, 0.2, 0.2]);
const ollamaEmbedBatch = vi.fn(async (_input: string[]): Promise<number[][]> => []);
const ollamaEmbedQuery = vi.fn(async (_input: string): Promise<number[]> => [0.3, 0.2, 0.1]);

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
}));

const createOllamaEmbeddingProviderMock = (params: {
  embedQuery: (input: string) => Promise<number[]>;
  embedBatch: (input: string[]) => Promise<number[][]>;
}) => ({
  requestedProvider: "ollama",
  provider: {
    id: "ollama",
    model: DEFAULT_OLLAMA_EMBEDDING_MODEL,
    embedQuery: params.embedQuery,
    embedBatch: params.embedBatch,
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434",
    headers: {},
    model: DEFAULT_OLLAMA_EMBEDDING_MODEL,
    embedBatch: params.embedBatch,
  },
});

const createUnavailableEmbeddingProviderMock = (requestedProvider = "openai") => ({
  requestedProvider,
  provider: null,
  providerUnavailableReason: "embedding provider unavailable",
});

describe("memory search async sync", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  const interceptPromoteStart = (activeManager: MemoryIndexManager, callback: () => void): void => {
    const hooks = activeManager as unknown as {
      onSafeReindexPromoteStart: () => Promise<void>;
    };
    const original = hooks.onSafeReindexPromoteStart.bind(activeManager);
    hooks.onSafeReindexPromoteStart = async () => {
      callback();
      await original();
    };
  };

  const resolveWithin = async <T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  const buildConfig = (params?: {
    fallback?: "none" | "ollama";
    hybridEnabled?: boolean;
    onSearch?: boolean;
    extraPaths?: string[];
    excludePaths?: string[];
  }): OpenClawConfig =>
    ({
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            fallback: params?.fallback ?? "none",
            store: { path: indexPath },
            sync: {
              watch: false,
              onSessionStart: false,
              onSearch: params?.onSearch ?? true,
            },
            extraPaths: params?.extraPaths,
            excludePaths: params?.excludePaths,
            query: {
              minScore: 0,
              hybrid: { enabled: params?.hybridEnabled ?? true },
            },
            remote: { batch: { enabled: false, wait: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    }) as OpenClawConfig;

  beforeEach(async () => {
    createEmbeddingProviderMock.mockReset();
    createEmbeddingProviderMock.mockImplementation(async (options: { provider?: string }) =>
      options.provider === "ollama"
        ? createOllamaEmbeddingProviderMock({
            embedQuery: ollamaEmbedQuery as unknown as (input: string) => Promise<number[]>,
            embedBatch: ollamaEmbedBatch as unknown as (input: string[]) => Promise<number[][]>,
          })
        : createOpenAIEmbeddingProviderMock({
            embedQuery: embedQuery as unknown as (input: string) => Promise<number[]>,
            embedBatch: embedBatch as unknown as (input: string[]) => Promise<number[][]>,
          }),
    );
    embedBatch.mockClear();
    embedBatch.mockImplementation(async (input: string[]) => input.map(() => [0.2, 0.2, 0.2]));
    embedQuery.mockClear();
    embedQuery.mockImplementation(async () => [0.2, 0.2, 0.2]);
    ollamaEmbedBatch.mockClear();
    ollamaEmbedBatch.mockImplementation(async (input: string[]) =>
      input.map(() => [0.3, 0.2, 0.1]),
    );
    ollamaEmbedQuery.mockClear();
    ollamaEmbedQuery.mockImplementation(async () => [0.3, 0.2, 0.1]);
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-async-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-07.md"), "hello\n");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("does not await sync when searching", async () => {
    const cfg = buildConfig();
    manager = await createMemoryManagerOrThrow(cfg);

    const pending = new Promise<void>(() => {});
    const syncMock = vi.fn(async () => pending);
    (manager as unknown as { sync: () => Promise<void> }).sync = syncMock;

    const activeManager = manager;
    if (!activeManager) {
      throw new Error("manager missing");
    }
    await activeManager.search("hello");
    expect(syncMock).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight search sync during close", async () => {
    const cfg = buildConfig();
    let releaseSync = () => {};
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    embedBatch.mockImplementation(async (input: string[]) => {
      await syncGate;
      return input.map(() => [0.3, 0.2, 0.1]);
    });

    manager = await createMemoryManagerOrThrow(cfg);
    await manager.search("hello");

    let closed = false;
    const closePromise = manager.close().then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);

    releaseSync();
    await closePromise;
    manager = null;
  });

  it("keeps searches on the last committed index while safe reindex builds a temp DB", async () => {
    const cfg = buildConfig();
    manager = await createMemoryManagerOrThrow(cfg);
    await manager.sync({ reason: "initial" });

    let releaseReindex = () => {};
    const reindexGate = new Promise<void>((resolve) => {
      releaseReindex = () => resolve();
    });
    let reindexStartedResolve = () => {};
    const reindexStarted = new Promise<void>((resolve) => {
      reindexStartedResolve = () => resolve();
    });
    let blockReindex = false;

    embedBatch.mockImplementation(async (input: string[]) => {
      if (!blockReindex) {
        return input.map(() => [0.2, 0.2, 0.2]);
      }
      reindexStartedResolve();
      await reindexGate;
      return input.map(() => [0.3, 0.2, 0.1]);
    });

    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-07.md"), "goodbye\n");
    blockReindex = true;
    const reindexPromise = manager.sync({ reason: "forced", force: true });
    await reindexStarted;

    const staleResults = await manager.search("hello");
    expect(staleResults.length).toBeGreaterThan(0);
    expect(staleResults[0]?.snippet).toContain("hello");
    expect(staleResults[0]?.snippet).not.toContain("goodbye");

    releaseReindex();
    await reindexPromise;

    const freshResults = await manager.search("goodbye");
    expect(freshResults.length).toBeGreaterThan(0);
    expect(freshResults[0]?.snippet).toContain("goodbye");
  });

  it("degrades snapshot searches to keyword-only during fallback reindexing", async () => {
    const cfg = buildConfig({ fallback: "ollama", hybridEnabled: true, onSearch: false });
    manager = await createMemoryManagerOrThrow(cfg);
    await manager.sync({ reason: "initial" });

    let releaseFallbackReindex = () => {};
    const fallbackReindexGate = new Promise<void>((resolve) => {
      releaseFallbackReindex = () => resolve();
    });
    let fallbackReindexStartedResolve = () => {};
    const fallbackReindexStarted = new Promise<void>((resolve) => {
      fallbackReindexStartedResolve = () => resolve();
    });
    let failPrimarySync = false;
    let blockFallbackReindex = false;

    embedBatch.mockImplementation(async (input: string[]) => {
      if (failPrimarySync) {
        failPrimarySync = false;
        throw new Error("embedding provider failed");
      }
      return input.map(() => [0.2, 0.2, 0.2]);
    });
    ollamaEmbedBatch.mockImplementation(async (input: string[]) => {
      if (blockFallbackReindex) {
        fallbackReindexStartedResolve();
        await fallbackReindexGate;
      }
      return input.map(() => [0.3, 0.2, 0.1]);
    });

    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-07.md"), "goodbye\n");
    (manager as unknown as { dirty: boolean }).dirty = true;

    failPrimarySync = true;
    blockFallbackReindex = true;
    const reindexPromise = manager.sync({ reason: "fallback-reindex" });
    await fallbackReindexStarted;

    const internal = manager as unknown as { provider?: { id: string } | null };
    expect(internal.provider?.id).toBe("ollama");

    embedQuery.mockClear();
    embedQuery.mockImplementation(async () => {
      throw new Error("old provider should not be used during fallback snapshot search");
    });
    const staleResults = await manager.search("hello");
    expect(staleResults.length).toBeGreaterThan(0);
    expect(staleResults[0]?.snippet).toContain("hello");
    expect(staleResults[0]?.snippet).not.toContain("goodbye");
    expect(embedQuery).not.toHaveBeenCalled();

    releaseFallbackReindex();
    await reindexPromise;

    const freshResults = await manager.search("goodbye");
    expect(freshResults.length).toBeGreaterThan(0);
    expect(freshResults[0]?.snippet).toContain("goodbye");
  });

  it("prunes excluded paths during provider outages while keeping keyword recall available", async () => {
    await fs.mkdir(path.join(workspaceDir, "activeclaw"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "hub-data"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "activeclaw", "README.md"), "alpha excluded");
    await fs.writeFile(
      path.join(workspaceDir, "hub-data", "events.jsonl"),
      '{"msg":"beta keep"}\n',
    );

    const initialCfg = buildConfig({
      extraPaths: [workspaceDir],
      hybridEnabled: true,
      onSearch: false,
    });
    manager = await createMemoryManagerOrThrow(initialCfg);
    await manager.sync({ reason: "initial" });
    await manager.close();
    manager = null;

    createEmbeddingProviderMock.mockImplementation(async (options: { provider?: string }) =>
      options.provider === "ollama"
        ? createOllamaEmbeddingProviderMock({
            embedQuery: ollamaEmbedQuery as unknown as (input: string) => Promise<number[]>,
            embedBatch: ollamaEmbedBatch as unknown as (input: string[]) => Promise<number[][]>,
          })
        : createUnavailableEmbeddingProviderMock(options.provider),
    );

    const outageCfg = buildConfig({
      extraPaths: [workspaceDir],
      excludePaths: ["activeclaw"],
      hybridEnabled: true,
      onSearch: false,
    });
    manager = await createMemoryManagerOrThrow(outageCfg);
    await manager.sync({ reason: "outage-reindex" });

    const excludedResults = await manager.search("alpha");
    expect(excludedResults.some((result) => result.path.includes("activeclaw/README.md"))).toBe(
      false,
    );

    const includedResults = await manager.search("beta");
    expect(includedResults.some((result) => result.path.includes("hub-data/events.jsonl"))).toBe(
      true,
    );
  });

  it("waits to promote a safe reindex until searches that started before the snapshot finish", async () => {
    const cfg = buildConfig({ hybridEnabled: false });
    manager = await createMemoryManagerOrThrow(cfg);
    await manager.sync({ reason: "initial" });

    let releaseSearch = () => {};
    const searchGate = new Promise<void>((resolve) => {
      releaseSearch = () => resolve();
    });
    let searchStartedResolve = () => {};
    const searchStarted = new Promise<void>((resolve) => {
      searchStartedResolve = () => resolve();
    });
    let blockSearch = true;

    let promoteStartedResolve = () => {};
    const promoteStarted = new Promise<void>((resolve) => {
      promoteStartedResolve = () => resolve();
    });
    interceptPromoteStart(manager, promoteStartedResolve);

    embedQuery.mockImplementation(async (_input: string) => {
      if (!blockSearch) {
        return [0.2, 0.2, 0.2];
      }
      searchStartedResolve();
      await searchGate;
      return [0.2, 0.2, 0.2];
    });

    let searchSettled = false;
    const searchPromise = manager.search("hello").then((results) => {
      searchSettled = true;
      return results;
    });
    await searchStarted;

    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-07.md"), "goodbye\n");

    let reindexSettled = false;
    const reindexPromise = manager.sync({ reason: "forced", force: true }).then(() => {
      reindexSettled = true;
    });

    await promoteStarted;
    await Promise.resolve();
    expect(searchSettled).toBe(false);
    expect(reindexSettled).toBe(false);

    blockSearch = false;
    releaseSearch();
    const staleResults = await searchPromise;
    expect(staleResults.length).toBeGreaterThan(0);
    expect(staleResults[0]?.snippet).toContain("hello");
    expect(staleResults[0]?.snippet).not.toContain("goodbye");

    await reindexPromise;
    const freshResults = await manager.search("goodbye");
    expect(freshResults.length).toBeGreaterThan(0);
    expect(freshResults[0]?.snippet).toContain("goodbye");
  });

  it("waits to promote a safe reindex until snapshot-backed searches finish", async () => {
    const cfg = buildConfig({ hybridEnabled: false });
    manager = await createMemoryManagerOrThrow(cfg);
    await manager.sync({ reason: "initial" });

    let releaseReindex = () => {};
    const reindexGate = new Promise<void>((resolve) => {
      releaseReindex = () => resolve();
    });
    let reindexStartedResolve = () => {};
    const reindexStarted = new Promise<void>((resolve) => {
      reindexStartedResolve = () => resolve();
    });
    let blockReindex = false;

    let promoteStartedResolve = () => {};
    const promoteStarted = new Promise<void>((resolve) => {
      promoteStartedResolve = () => resolve();
    });
    interceptPromoteStart(manager, promoteStartedResolve);

    let releaseSearch = () => {};
    const searchGate = new Promise<void>((resolve) => {
      releaseSearch = () => resolve();
    });
    let searchStartedResolve = () => {};
    const searchStarted = new Promise<void>((resolve) => {
      searchStartedResolve = () => resolve();
    });
    let blockSearch = false;

    embedBatch.mockImplementation(async (input: string[]) => {
      if (!blockReindex) {
        return input.map(() => [0.2, 0.2, 0.2]);
      }
      reindexStartedResolve();
      await reindexGate;
      return input.map(() => [0.3, 0.2, 0.1]);
    });
    embedQuery.mockImplementation(async (_input: string) => {
      if (!blockSearch) {
        return [0.2, 0.2, 0.2];
      }
      searchStartedResolve();
      await searchGate;
      return [0.2, 0.2, 0.2];
    });

    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-07.md"), "goodbye\n");
    blockReindex = true;
    const reindexPromise = manager.sync({ reason: "forced", force: true });
    await reindexStarted;

    blockSearch = true;
    let searchSettled = false;
    const searchPromise = manager.search("hello").then((results) => {
      searchSettled = true;
      return results;
    });
    await searchStarted;

    let reindexSettled = false;
    const trackedReindexPromise = reindexPromise.then(() => {
      reindexSettled = true;
    });

    releaseReindex();
    await promoteStarted;
    expect(searchSettled).toBe(false);
    expect(reindexSettled).toBe(false);

    blockSearch = false;
    releaseSearch();
    const staleResults = await searchPromise;
    expect(staleResults.length).toBeGreaterThan(0);
    expect(staleResults[0]?.snippet).toContain("hello");
    expect(staleResults[0]?.snippet).not.toContain("goodbye");

    await trackedReindexPromise;
    const freshResults = await manager.search("goodbye");
    expect(freshResults.length).toBeGreaterThan(0);
    expect(freshResults[0]?.snippet).toContain("goodbye");
  });

  it("does not deadlock close while promote waits on an in-flight search", async () => {
    const cfg = buildConfig({ hybridEnabled: false });
    manager = await createMemoryManagerOrThrow(cfg);
    await manager.sync({ reason: "initial" });

    let releaseReindex = () => {};
    const reindexGate = new Promise<void>((resolve) => {
      releaseReindex = () => resolve();
    });
    let reindexStartedResolve = () => {};
    const reindexStarted = new Promise<void>((resolve) => {
      reindexStartedResolve = () => resolve();
    });
    let blockReindex = false;

    let promoteStartedResolve = () => {};
    const promoteStarted = new Promise<void>((resolve) => {
      promoteStartedResolve = () => resolve();
    });
    interceptPromoteStart(manager, promoteStartedResolve);

    let releaseSearch = () => {};
    const searchGate = new Promise<void>((resolve) => {
      releaseSearch = () => resolve();
    });
    let searchStartedResolve = () => {};
    const searchStarted = new Promise<void>((resolve) => {
      searchStartedResolve = () => resolve();
    });
    let blockSearch = false;

    embedBatch.mockImplementation(async (input: string[]) => {
      if (!blockReindex) {
        return input.map(() => [0.2, 0.2, 0.2]);
      }
      reindexStartedResolve();
      await reindexGate;
      return input.map(() => [0.3, 0.2, 0.1]);
    });
    embedQuery.mockImplementation(async (_input: string) => {
      if (!blockSearch) {
        return [0.2, 0.2, 0.2];
      }
      searchStartedResolve();
      await searchGate;
      return [0.2, 0.2, 0.2];
    });

    await fs.writeFile(path.join(workspaceDir, "memory", "2026-01-07.md"), "goodbye\n");
    blockReindex = true;
    const reindexPromise = manager.sync({ reason: "forced", force: true });
    await reindexStarted;

    blockSearch = true;
    const searchPromise = manager.search("hello");
    await searchStarted;

    releaseReindex();
    await promoteStarted;

    let closed = false;
    const closePromise = manager.close().then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);

    blockSearch = false;
    releaseSearch();
    const staleResults = await searchPromise;
    expect(staleResults.length).toBeGreaterThan(0);
    expect(staleResults[0]?.snippet).toContain("hello");
    expect(staleResults[0]?.snippet).not.toContain("goodbye");

    await expect(resolveWithin(closePromise)).resolves.toBeUndefined();
    await expect(resolveWithin(reindexPromise)).resolves.toBeUndefined();
    manager = null;
  });
});
