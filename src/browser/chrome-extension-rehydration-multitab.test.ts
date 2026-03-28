/**
 * Multi-tab mixed-state tests for chrome extension MV3 rehydration logic.
 *
 * Gap identified in obl-1fd485b3bc95:
 * The original test suite's createMockChrome uses a single shared boolean
 * `opts.debuggerAttached` for all tabs. This means:
 *   - chrome.debugger.attach() on tab B sets debuggerAttached=true globally
 *   - tab C's subsequent validation silently passes even if its debugger
 *     was never actually re-attached
 *   - ordering-dependent bugs are masked
 *
 * Fix: createMockChromePerTab uses a Map<tabId, boolean> for per-tab
 * debugger state. Each tab's attach/detach/sendCommand operates on its
 * own isolated state.
 *
 * Authored by quadricep for obl-1fd485b3bc95.
 */
import { describe, expect, it, vi } from "vitest";

// ── Mock types (same as original suite) ─────────────────────────────────
type PersistedTab = {
  tabId: number;
  sessionId: string;
  targetId: string;
  attachOrder?: number;
};

type TabState = {
  state: string;
  sessionId: string;
  targetId: string;
  attachOrder?: number;
};

// ── Per-tab mock Chrome APIs ────────────────────────────────────────────

type PerTabDebuggerState = {
  exists: boolean;
  debuggerAttached: boolean;
  attachSucceeds: boolean;
};

function createMockChromePerTab(tabStates: Map<number, PerTabDebuggerState>) {
  const attachCalls: number[] = [];
  const detachCalls: number[] = [];

  return {
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const state = tabStates.get(tabId);
        if (!state || !state.exists) {
          throw new Error(`No tab with id: ${tabId}`);
        }
        return { id: tabId, url: "https://example.com", status: "complete" };
      }),
    },
    debugger: {
      sendCommand: vi.fn(
        async (_debuggee: { tabId: number }, method: string, _params?: unknown) => {
          const state = tabStates.get(_debuggee.tabId);
          if (!state || !state.debuggerAttached) {
            throw new Error("Debugger is not attached to the tab with id: " + _debuggee.tabId);
          }
          if (method === "Runtime.evaluate") {
            return { result: { type: "number", value: 1 } };
          }
          return {};
        },
      ),
      attach: vi.fn(async (debuggee: { tabId: number }, _version: string) => {
        const state = tabStates.get(debuggee.tabId);
        if (!state || !state.attachSucceeds) {
          throw new Error("Cannot attach to this target");
        }
        attachCalls.push(debuggee.tabId);
        // Only mutate THIS tab's debugger state
        state.debuggerAttached = true;
      }),
      detach: vi.fn(async (debuggee: { tabId: number }) => {
        const state = tabStates.get(debuggee.tabId);
        if (state) {
          state.debuggerAttached = false;
        }
        detachCalls.push(debuggee.tabId);
      }),
    },
    storage: {
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setBadgeTextColor: vi.fn(async () => {}),
    },
    attachCalls,
    detachCalls,
  };
}

// ── Rehydration logic (copied from original suite, unchanged) ───────────

const TAB_VALIDATION_ATTEMPTS = 2;

async function validateAttachedTab(
  chrome: ReturnType<typeof createMockChromePerTab>,
  tabId: number,
): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < TAB_VALIDATION_ATTEMPTS; attempt++) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "1",
        returnByValue: true,
      });
      return true;
    } catch (err) {
      if (err instanceof Error && err.message.includes("No tab with id")) {
        return false;
      }
      if (attempt < TAB_VALIDATION_ATTEMPTS - 1) {
        // In real code this is a 1000ms sleep; we skip in tests
      }
    }
  }
  return false;
}

/** Current rehydrateState: validates then deletes on failure */
async function currentRehydrateState(
  chrome: ReturnType<typeof createMockChromePerTab>,
  entries: PersistedTab[],
): Promise<{ tabs: Map<number, TabState>; tabBySession: Map<string, number> }> {
  const tabs = new Map<number, TabState>();
  const tabBySession = new Map<string, number>();

  for (const entry of entries) {
    tabs.set(entry.tabId, {
      state: "connected",
      sessionId: entry.sessionId,
      targetId: entry.targetId,
      attachOrder: entry.attachOrder,
    });
    tabBySession.set(entry.sessionId, entry.tabId);
  }

  for (const entry of entries) {
    const valid = await validateAttachedTab(chrome, entry.tabId);
    if (!valid) {
      tabs.delete(entry.tabId);
      tabBySession.delete(entry.sessionId);
    }
  }

  return { tabs, tabBySession };
}

/** Desired rehydrateState: validates, then RE-ATTACHES on failure if tab exists */
async function desiredRehydrateState(
  chrome: ReturnType<typeof createMockChromePerTab>,
  entries: PersistedTab[],
): Promise<{ tabs: Map<number, TabState>; tabBySession: Map<string, number> }> {
  const tabs = new Map<number, TabState>();
  const tabBySession = new Map<string, number>();

  for (const entry of entries) {
    tabs.set(entry.tabId, {
      state: "connected",
      sessionId: entry.sessionId,
      targetId: entry.targetId,
      attachOrder: entry.attachOrder,
    });
    tabBySession.set(entry.sessionId, entry.tabId);
  }

  for (const entry of entries) {
    const valid = await validateAttachedTab(chrome, entry.tabId);
    if (!valid) {
      try {
        await chrome.tabs.get(entry.tabId);
        await chrome.debugger.attach({ tabId: entry.tabId }, "1.3");
        const validAfterReattach = await validateAttachedTab(chrome, entry.tabId);
        if (!validAfterReattach) {
          tabs.delete(entry.tabId);
          tabBySession.delete(entry.sessionId);
        }
      } catch {
        tabs.delete(entry.tabId);
        tabBySession.delete(entry.sessionId);
      }
    }
  }

  return { tabs, tabBySession };
}

// ── Multi-tab mixed-state tests ─────────────────────────────────────────

describe("multi-tab mixed debugger state (per-tab mock isolation)", () => {
  const entries: PersistedTab[] = [
    { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 1 },
    { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 2 },
  ];

  describe("currentRehydrateState — mixed state", () => {
    it("keeps attached tab A, deletes detached tab B", async () => {
      const tabStates = new Map<number, PerTabDebuggerState>([
        [42, { exists: true, debuggerAttached: true, attachSucceeds: true }],
        [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
      ]);
      const chrome = createMockChromePerTab(tabStates);

      const { tabs, tabBySession } = await currentRehydrateState(chrome, entries);

      // Tab 42 (attached) survives
      expect(tabs.has(42)).toBe(true);
      expect(tabBySession.has("cb-tab-42")).toBe(true);

      // Tab 99 (detached) gets deleted — the current bug behavior
      expect(tabs.has(99)).toBe(false);
      expect(tabBySession.has("cb-tab-99")).toBe(false);

      // No re-attach was attempted (current code doesn't try)
      expect(chrome.attachCalls).toHaveLength(0);
    });

    it("ordering does not leak state: B-then-A produces same result", async () => {
      // Reverse order: detached tab first, attached tab second
      const reversedEntries: PersistedTab[] = [
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 1 },
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 2 },
      ];
      const tabStates = new Map<number, PerTabDebuggerState>([
        [42, { exists: true, debuggerAttached: true, attachSucceeds: true }],
        [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
      ]);
      const chrome = createMockChromePerTab(tabStates);

      const { tabs } = await currentRehydrateState(chrome, reversedEntries);

      // Same result regardless of iteration order
      expect(tabs.has(42)).toBe(true);
      expect(tabs.has(99)).toBe(false);
    });
  });

  describe("desiredRehydrateState — mixed state", () => {
    it("keeps attached tab A without re-attach, re-attaches detached tab B", async () => {
      const tabStates = new Map<number, PerTabDebuggerState>([
        [42, { exists: true, debuggerAttached: true, attachSucceeds: true }],
        [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
      ]);
      const chrome = createMockChromePerTab(tabStates);

      const { tabs, tabBySession } = await desiredRehydrateState(chrome, entries);

      // Tab 42 (attached) survives without re-attach
      expect(tabs.has(42)).toBe(true);
      expect(tabBySession.has("cb-tab-42")).toBe(true);

      // Tab 99 (detached) survives via re-attach
      expect(tabs.has(99)).toBe(true);
      expect(tabBySession.has("cb-tab-99")).toBe(true);

      // Only tab 99 triggered a re-attach call
      expect(chrome.attachCalls).toEqual([99]);
    });

    it("re-attach on tab B does not leak debugger state to tab C", async () => {
      // Three tabs: A attached, B detached (re-attachable), C detached (attach fails)
      const threeEntries: PersistedTab[] = [
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 1 },
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 2 },
        { tabId: 150, sessionId: "cb-tab-150", targetId: "t-150", attachOrder: 3 },
      ];
      const tabStates = new Map<number, PerTabDebuggerState>([
        [42, { exists: true, debuggerAttached: true, attachSucceeds: true }],
        [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
        [150, { exists: true, debuggerAttached: false, attachSucceeds: false }],
      ]);
      const chrome = createMockChromePerTab(tabStates);

      const { tabs } = await desiredRehydrateState(chrome, threeEntries);

      // Tab 42: survives (was attached)
      expect(tabs.has(42)).toBe(true);
      // Tab 99: survives (re-attached successfully)
      expect(tabs.has(99)).toBe(true);
      // Tab 150: deleted (re-attach failed)
      // With the old shared-boolean mock, re-attaching tab 99 would have
      // set debuggerAttached=true globally, making tab 150's validation
      // pass even though its own attach failed. Per-tab isolation catches this.
      expect(tabs.has(150)).toBe(false);

      // Only tab 99 was successfully attached
      expect(chrome.attachCalls).toEqual([99]);
    });

    it("ordering B-then-A produces identical results", async () => {
      const reversedEntries: PersistedTab[] = [
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 1 },
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 2 },
      ];
      const tabStates = new Map<number, PerTabDebuggerState>([
        [42, { exists: true, debuggerAttached: true, attachSucceeds: true }],
        [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
      ]);
      const chrome = createMockChromePerTab(tabStates);

      const { tabs } = await desiredRehydrateState(chrome, reversedEntries);

      // Both survive regardless of order
      expect(tabs.has(42)).toBe(true);
      expect(tabs.has(99)).toBe(true);

      // Only tab 99 needed re-attach
      expect(chrome.attachCalls).toEqual([99]);
    });

    it("tab gone + tab detached: gone is deleted, detached is re-attached", async () => {
      const mixedEntries: PersistedTab[] = [
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 1 },
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 2 },
      ];
      const tabStates = new Map<number, PerTabDebuggerState>([
        [42, { exists: false, debuggerAttached: false, attachSucceeds: false }],
        [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
      ]);
      const chrome = createMockChromePerTab(tabStates);

      const { tabs } = await desiredRehydrateState(chrome, mixedEntries);

      // Tab 42: gone → deleted
      expect(tabs.has(42)).toBe(false);
      // Tab 99: detached → re-attached → survives
      expect(tabs.has(99)).toBe(true);

      expect(chrome.attachCalls).toEqual([99]);
    });
  });

  describe("proves the original shared-boolean mock masks the bug", () => {
    it("shared-boolean mock: re-attach on tab B leaks to tab C validation", async () => {
      // This test uses a DELIBERATELY BROKEN shared-boolean mock
      // to demonstrate the exact gap in the original suite.
      //
      // With shared state: attach(99) sets debuggerAttached=true globally,
      // so tab 150's sendCommand succeeds even though 150 was never attached.

      const sharedOpts = {
        tabExists: true,
        debuggerAttached: false,
        attachSucceeds: true,
      };

      // Manually inline the original mock shape for clarity
      const attachCalls: number[] = [];
      const sharedChrome = {
        tabs: {
          get: vi.fn(async (tabId: number) => {
            if (!sharedOpts.tabExists) {
              throw new Error(`No tab with id: ${tabId}`);
            }
            return { id: tabId, url: "https://example.com", status: "complete" };
          }),
        },
        debugger: {
          sendCommand: vi.fn(async (_debuggee: { tabId: number }, method: string) => {
            if (!sharedOpts.debuggerAttached) {
              throw new Error("Debugger is not attached to the tab with id: " + _debuggee.tabId);
            }
            if (method === "Runtime.evaluate") {
              return { result: { type: "number", value: 1 } };
            }
            return {};
          }),
          attach: vi.fn(async (debuggee: { tabId: number }, _version: string) => {
            attachCalls.push(debuggee.tabId);
            sharedOpts.debuggerAttached = true; // GLOBAL mutation — the bug
          }),
          detach: vi.fn(async () => {}),
        },
        storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
        action: {
          setBadgeText: vi.fn(async () => {}),
          setBadgeBackgroundColor: vi.fn(async () => {}),
          setBadgeTextColor: vi.fn(async () => {}),
        },
        attachCalls,
        detachCalls: [] as number[],
      };

      const threeEntries: PersistedTab[] = [
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 1 },
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 2 },
        { tabId: 150, sessionId: "cb-tab-150", targetId: "t-150", attachOrder: 3 },
      ];

      // All three tabs start detached. desiredRehydrateState will:
      // 1. Validate tab 42 → fail → re-attach → attach sets global=true
      // 2. Validate tab 99 → PASS (because global is now true!) → no re-attach
      // 3. Validate tab 150 → PASS (same leak) → no re-attach
      //
      // This is WRONG: in production, only tab 42 was re-attached.
      // Tabs 99 and 150 would still have dead debugger sessions.
      const result = await desiredRehydrateState(
        sharedChrome as unknown as ReturnType<typeof createMockChromePerTab>,
        threeEntries,
      );

      // With shared-boolean mock, all three survive (incorrectly!)
      expect(result.tabs.size).toBe(3);
      // Only tab 42 was actually re-attached
      expect(attachCalls).toEqual([42]);
      // Tabs 99 and 150 were never attached but passed validation
      // because of the leaked global state — this is the masked bug.
    });

    it("per-tab mock: same scenario correctly requires re-attach for each tab", async () => {
      const threeEntries: PersistedTab[] = [
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 1 },
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 2 },
        { tabId: 150, sessionId: "cb-tab-150", targetId: "t-150", attachOrder: 3 },
      ];
      const tabStates = new Map<number, PerTabDebuggerState>([
        [42, { exists: true, debuggerAttached: false, attachSucceeds: true }],
        [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
        [150, { exists: true, debuggerAttached: false, attachSucceeds: true }],
      ]);
      const chrome = createMockChromePerTab(tabStates);

      const result = await desiredRehydrateState(chrome, threeEntries);

      // All three survive — but each was individually re-attached
      expect(result.tabs.size).toBe(3);
      // All three tabs required their own attach call
      expect(chrome.attachCalls).toEqual([42, 99, 150]);
    });
  });
});
