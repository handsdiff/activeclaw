import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  decodeHistoryPathSegment,
  encodeHistoryPathSegment,
  resolveChannelHistoryShardDir,
} from "./paths.js";

function createCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        history: {
          enabled: true,
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

describe("history paths", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  beforeEach(() => {
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-history-paths";
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("encodes and decodes path segments canonically", () => {
    const raw = "telegram:group/123%topic";
    const encoded = encodeHistoryPathSegment(raw);
    expect(encoded).toBe("telegram%3Agroup%2F123%25topic");
    expect(decodeHistoryPathSegment(encoded)).toBe(raw);
  });

  it("places channel shards under the agent-scoped history tree", () => {
    const dir = resolveChannelHistoryShardDir({
      cfg: createCfg(),
      agentId: "main",
      surface: "telegram",
      conversationKey: "telegram:123/alpha",
      ts: "2026-03-08T01:23:06.600Z",
    });
    expect(dir).toBe(
      path.join(
        "/tmp/openclaw-history-paths",
        "agents",
        "main",
        "history",
        "channel",
        "telegram",
        "telegram%3A123%2Falpha",
        "2026-03-08",
      ),
    );
  });
});
