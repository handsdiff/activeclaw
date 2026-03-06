import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemorySearchResult } from "../../memory/types.js";
import { runPreTurnMemoryRecall } from "./agent-runner-recall.js";

const searchMock =
  vi.fn<
    (
      query: string,
      opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
    ) => Promise<MemorySearchResult[]>
  >();
const getMemorySearchManagerMock = vi.fn();

vi.mock("../../memory/search-manager.js", () => ({
  getMemorySearchManager: (...args: unknown[]) => getMemorySearchManagerMock(...args),
}));

const cfg = {
  agents: {
    defaults: {
      memoryRecall: {
        enabled: true,
        minMessageLength: 1,
        maxResults: 3,
        minScore: 0.2,
        maxTokens: 500,
      },
      memorySearch: {
        sources: ["memory", "sessions"],
        extraPaths: ["/tmp/workspace", "/tmp/cron", "/tmp/logs", "/tmp/openclaw.json"],
        experimental: {
          sessionMemory: true,
        },
      },
    },
    list: [{ id: "main", default: true }],
  },
} as const;

describe("runPreTurnMemoryRecall", () => {
  beforeEach(() => {
    searchMock.mockReset();
    getMemorySearchManagerMock.mockReset();
    getMemorySearchManagerMock.mockResolvedValue({
      manager: {
        search: searchMock,
      },
    });
  });

  it("injects an operating brief with search surface guidance and cited recall hits", async () => {
    searchMock.mockResolvedValue([
      {
        path: "sessions/demo.jsonl",
        startLine: 12,
        endLine: 13,
        snippet: "User asked about the cron rollout.",
        score: 0.91,
        source: "sessions",
      },
      {
        path: "../../.openclaw/openclaw.json",
        startLine: 3,
        endLine: 6,
        snippet: '"memorySearch": { "sources": ["memory", "sessions"] }',
        score: 0.77,
        source: "memory",
      },
    ]);

    const block = await runPreTurnMemoryRecall({
      cfg,
      agentId: "main",
      incomingMessage: "What did we decide about cron-driven retrieval?",
      isHeartbeat: false,
      sessionKey: "agent:main:telegram:direct:123",
    });

    expect(block).toContain("## Operating Brief");
    expect(block).toContain("Indexed operating surface:");
    expect(block).toContain("Session transcripts included in semantic recall.");
    expect(block).toContain("Configured cron artifacts.");
    expect(block).toContain("Configured operational logs and JSONL artifacts.");
    expect(block).toContain("Configured workspace/config files.");
    expect(block).toContain(
      "- Session: [sessions/demo.jsonl#L12] User asked about the cron rollout.",
    );
    expect(block).toContain(
      '- Config: [../../.openclaw/openclaw.json#L3] "memorySearch": { "sources": ["memory", "sessions"] }',
    );
  });

  it("still injects an operating brief when no auto-recall hits are found", async () => {
    searchMock.mockResolvedValue([]);

    const block = await runPreTurnMemoryRecall({
      cfg,
      agentId: "main",
      incomingMessage: "hello there",
      isHeartbeat: false,
      sessionKey: "agent:main:telegram:direct:123",
    });

    expect(block).toContain("## Operating Brief");
    expect(block).toContain("No high-confidence auto-recall hits were selected for this message.");
    expect(block).toContain("expand recall before answering");
  });
});
