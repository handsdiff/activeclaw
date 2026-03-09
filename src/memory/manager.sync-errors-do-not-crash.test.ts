import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getEmbedBatchMock, resetEmbeddingMocks } from "./embedding.test-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { getRequiredMemoryIndexManager } from "./test-manager-helpers.js";

describe("memory manager sync failures", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;
  const embedBatch = getEmbedBatchMock();

  beforeEach(async () => {
    vi.useFakeTimers();
    resetEmbeddingMocks();
    embedBatch.mockImplementation(async () => {
      throw new Error("openai embeddings failed: 400 bad request");
    });
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello");
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("does not raise unhandledRejection when watch-triggered sync fails", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: true, watchDebounceMs: 1, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });
    const syncSpy = vi.spyOn(manager, "sync");

    // Call the internal scheduler directly; it uses fire-and-forget sync.
    (manager as unknown as { scheduleWatchSync: () => void }).scheduleWatchSync();

    await vi.runOnlyPendingTimersAsync();
    const syncPromise = syncSpy.mock.results[0]?.value as Promise<void> | undefined;
    vi.useRealTimers();
    if (syncPromise) {
      await syncPromise.catch(() => undefined);
    }

    process.off("unhandledRejection", handler);
    expect(unhandled).toHaveLength(0);
  });

  it("schedules watch sync for history-only sources", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          history: {
            enabled: true,
          },
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sources: ["history"],
            sync: { watch: true, watchDebounceMs: 1, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });
    const syncSpy = vi.spyOn(manager, "sync");

    (manager as unknown as { scheduleWatchSync: () => void }).scheduleWatchSync();

    await vi.runOnlyPendingTimersAsync();
    const syncPromise = syncSpy.mock.results[0]?.value as Promise<void> | undefined;
    vi.useRealTimers();
    if (syncPromise) {
      await syncPromise.catch(() => undefined);
    }

    process.off("unhandledRejection", handler);
    expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
    expect(unhandled).toHaveLength(0);
  });

  it("runs periodic history retention sweeps for long-lived managers", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          history: {
            enabled: true,
            retention: {
              days: 7,
            },
          },
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sources: ["memory"],
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });
    const sweepSpy = vi.spyOn(
      manager as unknown as { runHistoryRetentionSweep: () => Promise<void> },
      "runHistoryRetentionSweep",
    );
    sweepSpy.mockClear();

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

    expect(sweepSpy).toHaveBeenCalled();
  });
});
