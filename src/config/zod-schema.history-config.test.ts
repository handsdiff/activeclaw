import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("history config validation", () => {
  it("rejects history on the qmd backend during Stage 1", () => {
    const parsed = OpenClawSchema.safeParse({
      memory: {
        backend: "qmd",
      },
      agents: {
        defaults: {
          history: {
            enabled: true,
          },
        },
        list: [{ id: "main", default: true }],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects memorySearch.sources=["history"] when history is disabled', () => {
    const parsed = OpenClawSchema.safeParse({
      agents: {
        defaults: {
          memorySearch: {
            sources: ["memory", "history"],
          },
        },
        list: [{ id: "main", default: true }],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts agent-scoped history paths", () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-history-schema";
    try {
      const parsed = OpenClawSchema.safeParse({
        agents: {
          defaults: {
            history: {
              enabled: true,
              path: "/tmp/openclaw-history-schema/agents/{agentId}/history",
            },
            memorySearch: {
              sources: ["memory", "history"],
            },
          },
          list: [{ id: "main", default: true }],
        },
      });
      expect(parsed.success).toBe(true);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });
});
