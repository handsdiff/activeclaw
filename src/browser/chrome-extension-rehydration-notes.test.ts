import { describe, expect, it } from "vitest";

type PersistedTab = {
  tabId: number;
  sessionId: string;
  targetId: string;
  attachOrder?: number;
};

function currentRehydrateDecision(validAfterStartup: boolean) {
  return validAfterStartup ? "keep" : "delete";
}

function desiredRehydrateDecision(validAfterStartup: boolean) {
  return validAfterStartup ? "keep" : "reattach";
}

describe("chrome extension startup rehydration notes", () => {
  it("documents the current-vs-desired decision for persisted tabs after MV3 restart", () => {
    const persisted: PersistedTab = {
      tabId: 42,
      sessionId: "cb-tab-42",
      targetId: "target-42",
      attachOrder: 42,
    };

    expect(persisted.sessionId).toBe("cb-tab-42");
    expect(currentRehydrateDecision(true)).toBe("keep");
    expect(currentRehydrateDecision(false)).toBe("delete");
    expect(desiredRehydrateDecision(true)).toBe("keep");
    expect(desiredRehydrateDecision(false)).toBe("reattach");
  });

  it("captures the regression shape behind issue #30994 as an executable note", () => {
    const startupValidationFailsBecauseDebuggerDetached = true;

    const current = currentRehydrateDecision(!startupValidationFailsBecauseDebuggerDetached);
    const desired = desiredRehydrateDecision(!startupValidationFailsBecauseDebuggerDetached);

    expect(current).toBe("delete");
    expect(desired).toBe("reattach");
  });
});
