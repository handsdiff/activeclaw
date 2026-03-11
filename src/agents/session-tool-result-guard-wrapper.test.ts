import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";

function getPersistedMessages(sm: SessionManager) {
  const messageEntries = sm.getEntries().filter((entry) => entry.type === "message") as Array<{
    message: unknown;
  }>;
  return messageEntries.map((entry) => entry.message);
}

describe("guardSessionManager", () => {
  it("persists user turns with input provenance metadata", () => {
    const sessionManager = guardSessionManager(SessionManager.inMemory(), {
      inputProvenance: {
        kind: "internal_system",
        sourceTool: "memory_flush",
        persistence: "ephemeral",
      },
    });

    sessionManager.appendMessage(
      castAgentMessage({
        role: "user",
        content: "Pre-compaction memory flush.",
        timestamp: 1,
      }) as Parameters<SessionManager["appendMessage"]>[0],
    );

    expect(getPersistedMessages(sessionManager)).toMatchObject([
      {
        role: "user",
        provenance: {
          kind: "internal_system",
          sourceTool: "memory_flush",
          persistence: "ephemeral",
        },
      },
    ]);
  });
});
