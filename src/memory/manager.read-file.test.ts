import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultAgentHistoryDir } from "../history/config.js";
import { appendChannelHistoryRecord } from "../history/writer.js";
import { resetEmbeddingMocks } from "./embedding.test-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { getRequiredMemoryIndexManager } from "./test-manager-helpers.js";

function createMemorySearchCfg(options: {
  workspaceDir: string;
  indexPath: string;
  extraPaths?: string[];
  excludePaths?: string[];
  sources?: Array<"memory" | "sessions" | "history">;
  historyEnabled?: boolean;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: options.workspaceDir,
        history: options.historyEnabled ? { enabled: true } : undefined,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: options.indexPath, vector: { enabled: false } },
          cache: { enabled: false },
          query: { minScore: 0, hybrid: { enabled: false } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          sources: options.sources,
          extraPaths: options.extraPaths,
          excludePaths: options.excludePaths,
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

describe("MemoryIndexManager.readFile", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    resetEmbeddingMocks();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-read-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("returns empty text when the requested file does not exist", async () => {
    manager = await getRequiredMemoryIndexManager({
      cfg: createMemorySearchCfg({ workspaceDir, indexPath }),
      agentId: "main",
    });

    const relPath = "memory/2099-01-01.md";
    const result = await manager.readFile({ relPath });
    expect(result).toEqual({ text: "", path: relPath });
  });

  it("returns content slices when the file exists", async () => {
    const relPath = "memory/2026-02-20.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, ["line 1", "line 2", "line 3"].join("\n"), "utf-8");

    manager = await getRequiredMemoryIndexManager({
      cfg: createMemorySearchCfg({ workspaceDir, indexPath }),
      agentId: "main",
    });

    const result = await manager.readFile({ relPath, from: 2, lines: 1 });
    expect(result).toEqual({ text: "line 2", path: relPath });
  });

  it("returns empty text when the requested slice is past EOF", async () => {
    const relPath = "memory/window.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, ["alpha", "beta"].join("\n"), "utf-8");

    manager = await getRequiredMemoryIndexManager({
      cfg: createMemorySearchCfg({ workspaceDir, indexPath }),
      agentId: "main",
    });

    const result = await manager.readFile({ relPath, from: 10, lines: 5 });
    expect(result).toEqual({ text: "", path: relPath });
  });

  it("returns empty text when the file disappears after stat", async () => {
    const relPath = "memory/transient.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "first\nsecond", "utf-8");

    manager = await getRequiredMemoryIndexManager({
      cfg: createMemorySearchCfg({ workspaceDir, indexPath }),
      agentId: "main",
    });

    const realReadFile = fs.readFile;
    let injected = false;
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: Parameters<typeof realReadFile>) => {
        const [target, options] = args;
        if (!injected && typeof target === "string" && path.resolve(target) === absPath) {
          injected = true;
          const err = new Error("missing") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return realReadFile(target, options);
      });

    const result = await manager.readFile({ relPath });
    expect(result).toEqual({ text: "", path: relPath });

    readSpy.mockRestore();
  });

  it("rejects non-memory workspace files unless they are in configured extra paths", async () => {
    const relPath = "src/app.ts";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "export const ok = true;\n", "utf-8");

    manager = await getRequiredMemoryIndexManager({
      cfg: createMemorySearchCfg({ workspaceDir, indexPath }),
      agentId: "main",
    });

    await expect(manager.readFile({ relPath })).rejects.toThrow("path required");
  });

  it("redacts sensitive values when reading indexed files from extra paths", async () => {
    const relPath = "config/openclaw.json";
    const absPath = path.join(workspaceDir, relPath);
    const raw = '{"apiKey":"sk-12345678901234567890","ok":true}';
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, raw, "utf-8");

    manager = await getRequiredMemoryIndexManager({
      cfg: createMemorySearchCfg({
        workspaceDir,
        indexPath,
        extraPaths: [path.join(workspaceDir, "config")],
      }),
      agentId: "main",
    });

    const result = await manager.readFile({ relPath });
    expect(result.path).toBe(relPath);
    expect(result.text).toContain('"apiKey"');
    expect(result.text).not.toContain("sk-12345678901234567890");
  });

  it("rejects files under excluded paths even when their parent extra path is indexed", async () => {
    const relPath = "activeclaw/README.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "# excluded\n", "utf-8");

    manager = await getRequiredMemoryIndexManager({
      cfg: createMemorySearchCfg({
        workspaceDir,
        indexPath,
        extraPaths: [workspaceDir],
        excludePaths: ["activeclaw"],
      }),
      agentId: "main",
    });

    await expect(manager.readFile({ relPath })).rejects.toThrow("path required");
  });

  it("allows reading durable history shards via history/ paths", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-read-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const cfg = createMemorySearchCfg({
        workspaceDir,
        indexPath,
        sources: ["memory", "history"],
        historyEnabled: true,
      });
      const appendResult = await appendChannelHistoryRecord({
        cfg,
        agentId: "main",
        surface: "telegram",
        conversationKey: "telegram:123",
        record: {
          kind: "channel_message",
          ts: "2026-03-08T01:23:06.600Z",
          surface: "telegram",
          conversationId: "telegram:123",
          direction: "inbound",
          disposition: "processed",
          messageId: "8030",
          senderId: "123",
          senderLabel: "Tester",
          text: "history readback marker",
          sessionKey: "agent:main:telegram:direct:123",
        },
      });
      expect(appendResult.path).toBeTruthy();

      manager = await getRequiredMemoryIndexManager({
        cfg,
        agentId: "main",
      });

      const historyRoot = resolveDefaultAgentHistoryDir("main");
      const relPath = path.join("history", path.relative(historyRoot, appendResult.path!));
      const result = await manager.readFile({ relPath });
      expect(result.path).toContain("history/channel/");
      expect(result.text).toContain("history readback marker");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
