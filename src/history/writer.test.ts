import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { appendChannelHistoryRecord } from "./writer.js";

function createCfg(
  historyPath: string,
  overrides?: Partial<OpenClawConfig["agents"]> & {
    history?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["history"];
  },
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        history: {
          enabled: true,
          path: historyPath,
          shard: {
            maxBytes: 4096,
            padWidth: 4,
          },
          ...overrides?.history,
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

describe("history writer", () => {
  let rootDir = "";
  let historyPath = "";
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-writer-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = rootDir;
    historyPath = path.join(rootDir, "agents", "main", "history");
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("rolls over to the next shard when appends exceed maxBytes", async () => {
    const cfg = createCfg(historyPath);
    const firstText = "first history shard payload ".repeat(140);
    const secondText = "second history shard payload ".repeat(140);
    const baseRecord = {
      kind: "channel_message" as const,
      ts: "2026-03-08T01:23:06.600Z",
      surface: "telegram",
      conversationId: "telegram:123",
      direction: "inbound" as const,
      disposition: "processed" as const,
      senderId: "123",
      senderLabel: "Tester",
      sessionKey: "agent:main:telegram:direct:123",
    };

    const first = await appendChannelHistoryRecord({
      cfg,
      agentId: "main",
      surface: "telegram",
      conversationKey: "telegram:123",
      record: {
        ...baseRecord,
        text: firstText,
      },
    });
    const second = await appendChannelHistoryRecord({
      cfg,
      agentId: "main",
      surface: "telegram",
      conversationKey: "telegram:123",
      record: {
        ...baseRecord,
        text: secondText,
      },
    });

    expect(first.path).toContain(path.join("2026-03-08", "0001.jsonl"));
    expect(second.path).toContain(path.join("2026-03-08", "0002.jsonl"));
  });

  it("omits quotedText when includeQuotedContext is false", async () => {
    const cfg = createCfg(historyPath, {
      history: {
        channel: {
          includeQuotedContext: false,
        },
      },
    });
    const result = await appendChannelHistoryRecord({
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
        senderId: "123",
        senderLabel: "Tester",
        text: "main text",
        quotedText: "should be omitted",
      },
    });

    const stored = JSON.parse(await fs.readFile(result.path!, "utf-8"));
    expect(stored.quotedText).toBeUndefined();
  });

  it("skips non-dispatched inbound records when includeNonDispatchedInbound is false", async () => {
    const cfg = createCfg(historyPath, {
      history: {
        channel: {
          includeNonDispatchedInbound: false,
        },
      },
    });
    const result = await appendChannelHistoryRecord({
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
        disposition: "blocked_dm_policy",
        senderId: "123",
        senderLabel: "Tester",
        text: "blocked inbound",
      },
    });

    expect(result.written).toBe(false);
  });
});
