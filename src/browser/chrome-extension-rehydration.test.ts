/**
 * Behavioral tests for chrome extension MV3 rehydration logic.
 *
 * These tests model the actual rehydrateState / validateAttachedTab flow
 * from assets/chrome-extension/background.js using minimal mocks of the
 * Chrome extension APIs. They capture the current behavior (delete on
 * validation failure) and the desired behavior (re-attach debugger).
 *
 * Context: After an MV3 service worker restart, chrome.storage.session
 * retains persisted tab entries but chrome.debugger sessions are dropped.
 * validateAttachedTab calls Runtime.evaluate which fails → tab is deleted.
 * The desired behavior is to re-attach the debugger instead.
 */
import { describe, expect, it, vi } from "vitest";

// ── Mock types ──────────────────────────────────────────────────────────
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

// ── Mock Chrome APIs ────────────────────────────────────────────────────

/**
 * Per-tab configuration for multi-tab scenarios.
 * When `perTab` is provided, each tab can have independent debugger state.
 * Falls back to top-level `tabExists`/`debuggerAttached` for single-tab tests.
 */
type MockChromeOpts = {
  tabExists: boolean;
  debuggerAttached: boolean;
  attachSucceeds?: boolean;
  perTab?: Map<number, { exists: boolean; debuggerAttached: boolean; attachSucceeds?: boolean }>;
};

function createMockChrome(opts: MockChromeOpts) {
  const attachCalls: number[] = [];
  const detachCalls: number[] = [];

  function getTabOpts(tabId: number) {
    return (
      opts.perTab?.get(tabId) ?? {
        exists: opts.tabExists,
        debuggerAttached: opts.debuggerAttached,
        attachSucceeds: opts.attachSucceeds,
      }
    );
  }

  return {
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const t = getTabOpts(tabId);
        if (!t.exists) {
          throw new Error(`No tab with id: ${tabId}`);
        }
        return { id: tabId, url: "https://example.com", status: "complete" };
      }),
    },
    debugger: {
      sendCommand: vi.fn(
        async (_debuggee: { tabId: number }, method: string, _params?: unknown) => {
          const t = getTabOpts(_debuggee.tabId);
          if (!t.debuggerAttached) {
            throw new Error("Debugger is not attached to the tab with id: " + _debuggee.tabId);
          }
          if (method === "Runtime.evaluate") {
            return { result: { type: "number", value: 1 } };
          }
          return {};
        },
      ),
      attach: vi.fn(async (debuggee: { tabId: number }, _version: string) => {
        const t = getTabOpts(debuggee.tabId);
        if (t.attachSucceeds === false) {
          throw new Error("Cannot attach to this target");
        }
        attachCalls.push(debuggee.tabId);
        // Update per-tab state if available, otherwise fall back to shared
        if (opts.perTab?.has(debuggee.tabId)) {
          opts.perTab.get(debuggee.tabId)!.debuggerAttached = true;
        } else {
          opts.debuggerAttached = true;
        }
      }),
      detach: vi.fn(async (debuggee: { tabId: number }) => {
        detachCalls.push(debuggee.tabId);
        if (opts.perTab?.has(debuggee.tabId)) {
          opts.perTab.get(debuggee.tabId)!.debuggerAttached = false;
        } else {
          opts.debuggerAttached = false;
        }
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

// ── Current behavior (from background.js) ───────────────────────────────

const TAB_VALIDATION_ATTEMPTS = 2;

async function validateAttachedTab(
  chrome: ReturnType<typeof createMockChrome>,
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
  chrome: ReturnType<typeof createMockChrome>,
  entries: PersistedTab[],
): Promise<{ tabs: Map<number, TabState>; tabBySession: Map<string, number> }> {
  const tabs = new Map<number, TabState>();
  const tabBySession = new Map<string, number>();

  // Phase 1: optimistically restore
  for (const entry of entries) {
    tabs.set(entry.tabId, {
      state: "connected",
      sessionId: entry.sessionId,
      targetId: entry.targetId,
      attachOrder: entry.attachOrder,
    });
    tabBySession.set(entry.sessionId, entry.tabId);
  }

  // Phase 2: validate — current code DELETES on failure
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
  chrome: ReturnType<typeof createMockChrome>,
  entries: PersistedTab[],
): Promise<{ tabs: Map<number, TabState>; tabBySession: Map<string, number> }> {
  const tabs = new Map<number, TabState>();
  const tabBySession = new Map<string, number>();

  // Phase 1: optimistically restore
  for (const entry of entries) {
    tabs.set(entry.tabId, {
      state: "connected",
      sessionId: entry.sessionId,
      targetId: entry.targetId,
      attachOrder: entry.attachOrder,
    });
    tabBySession.set(entry.sessionId, entry.tabId);
  }

  // Phase 2: validate — desired code RE-ATTACHES on failure
  for (const entry of entries) {
    const valid = await validateAttachedTab(chrome, entry.tabId);
    if (!valid) {
      // Check if tab still exists before attempting re-attach
      try {
        await chrome.tabs.get(entry.tabId);
        // Tab exists but debugger detached — re-attach
        await chrome.debugger.attach({ tabId: entry.tabId }, "1.3");
        // Validate again after re-attach
        const validAfterReattach = await validateAttachedTab(chrome, entry.tabId);
        if (!validAfterReattach) {
          tabs.delete(entry.tabId);
          tabBySession.delete(entry.sessionId);
        }
      } catch {
        // Tab gone or attach failed — remove
        tabs.delete(entry.tabId);
        tabBySession.delete(entry.sessionId);
      }
    }
  }

  return { tabs, tabBySession };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("chrome extension MV3 rehydration — behavioral tests", () => {
  const persistedTab: PersistedTab = {
    tabId: 42,
    sessionId: "cb-tab-42",
    targetId: "target-42",
    attachOrder: 1,
  };

  describe("validateAttachedTab", () => {
    it("returns true when tab exists and debugger is attached", async () => {
      const chrome = createMockChrome({ tabExists: true, debuggerAttached: true });
      expect(await validateAttachedTab(chrome, 42)).toBe(true);
      expect(chrome.debugger.sendCommand).toHaveBeenCalledTimes(1);
    });

    it("returns false when tab does not exist", async () => {
      const chrome = createMockChrome({ tabExists: false, debuggerAttached: false });
      expect(await validateAttachedTab(chrome, 42)).toBe(false);
      expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("returns false when tab exists but debugger is detached (MV3 restart)", async () => {
      const chrome = createMockChrome({ tabExists: true, debuggerAttached: false });
      expect(await validateAttachedTab(chrome, 42)).toBe(false);
      // Should have retried TAB_VALIDATION_ATTEMPTS times
      expect(chrome.debugger.sendCommand).toHaveBeenCalledTimes(TAB_VALIDATION_ATTEMPTS);
    });
  });

  describe("current rehydrateState (delete on failure)", () => {
    it("keeps tab when debugger is still attached", async () => {
      const chrome = createMockChrome({ tabExists: true, debuggerAttached: true });
      const { tabs, tabBySession } = await currentRehydrateState(chrome, [persistedTab]);
      expect(tabs.has(42)).toBe(true);
      expect(tabBySession.has("cb-tab-42")).toBe(true);
    });

    it("DELETES tab when debugger is detached after MV3 restart — this is the bug", async () => {
      const chrome = createMockChrome({ tabExists: true, debuggerAttached: false });
      const { tabs, tabBySession } = await currentRehydrateState(chrome, [persistedTab]);
      // Current behavior: tab is deleted even though it still exists
      expect(tabs.has(42)).toBe(false);
      expect(tabBySession.has("cb-tab-42")).toBe(false);
      // Debugger.attach was never called — that's the missing step
      expect(chrome.attachCalls).toHaveLength(0);
    });

    it("deletes tab when tab no longer exists", async () => {
      const chrome = createMockChrome({ tabExists: false, debuggerAttached: false });
      const { tabs, tabBySession } = await currentRehydrateState(chrome, [persistedTab]);
      expect(tabs.has(42)).toBe(false);
      expect(tabBySession.has("cb-tab-42")).toBe(false);
    });

    it("handles multiple tabs — keeps attached, deletes detached", async () => {
      // Tab 42: attached, Tab 99: detached — per-tab debugger state
      const entries: PersistedTab[] = [
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 1 },
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 2 },
      ];
      const chrome = createMockChrome({
        tabExists: true,
        debuggerAttached: false,
        perTab: new Map([
          [42, { exists: true, debuggerAttached: true }],
          [99, { exists: true, debuggerAttached: false }],
        ]),
      });
      const { tabs } = await currentRehydrateState(chrome, entries);
      // Tab 42 survives (debugger attached), tab 99 deleted (debugger detached)
      expect(tabs.has(42)).toBe(true);
      expect(tabs.has(99)).toBe(false);
      expect(tabs.size).toBe(1);
    });
  });

  describe("desired rehydrateState (re-attach on failure)", () => {
    it("keeps tab when debugger is still attached (no re-attach needed)", async () => {
      const chrome = createMockChrome({ tabExists: true, debuggerAttached: true });
      const { tabs, tabBySession } = await desiredRehydrateState(chrome, [persistedTab]);
      expect(tabs.has(42)).toBe(true);
      expect(tabBySession.has("cb-tab-42")).toBe(true);
      // No re-attach needed
      expect(chrome.attachCalls).toHaveLength(0);
    });

    it("RE-ATTACHES debugger when tab exists but debugger detached after MV3 restart", async () => {
      const chrome = createMockChrome({
        tabExists: true,
        debuggerAttached: false,
        attachSucceeds: true,
      });
      const { tabs, tabBySession } = await desiredRehydrateState(chrome, [persistedTab]);
      // Tab should be kept after re-attach
      expect(tabs.has(42)).toBe(true);
      expect(tabBySession.has("cb-tab-42")).toBe(true);
      // debugger.attach was called — the key difference from current behavior
      expect(chrome.attachCalls).toContain(42);
    });

    it("deletes tab when tab exists but re-attach fails", async () => {
      const chrome = createMockChrome({
        tabExists: true,
        debuggerAttached: false,
        attachSucceeds: false,
      });
      const { tabs, tabBySession } = await desiredRehydrateState(chrome, [persistedTab]);
      // Re-attach failed, so tab should be removed
      expect(tabs.has(42)).toBe(false);
      expect(tabBySession.has("cb-tab-42")).toBe(false);
    });

    it("deletes tab when tab no longer exists", async () => {
      const chrome = createMockChrome({ tabExists: false, debuggerAttached: false });
      const { tabs, tabBySession } = await desiredRehydrateState(chrome, [persistedTab]);
      expect(tabs.has(42)).toBe(false);
      expect(tabBySession.has("cb-tab-42")).toBe(false);
    });

    it("re-attaches only detached tabs in multi-tab scenario", async () => {
      // Tab 42: attached (should keep without re-attach)
      // Tab 99: detached (should re-attach)
      const entries: PersistedTab[] = [
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 1 },
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 2 },
      ];
      const chrome = createMockChrome({
        tabExists: true,
        debuggerAttached: false,
        perTab: new Map([
          [42, { exists: true, debuggerAttached: true }],
          [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
        ]),
      });
      const { tabs } = await desiredRehydrateState(chrome, entries);
      // Both should survive
      expect(tabs.has(42)).toBe(true);
      expect(tabs.has(99)).toBe(true);
      expect(tabs.size).toBe(2);
      // Only tab 99 needed re-attach
      expect(chrome.attachCalls).toEqual([99]);
    });

    it("handles mixed outcomes: one re-attaches, one fails", async () => {
      const entries: PersistedTab[] = [
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 1 },
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 2 },
      ];
      const chrome = createMockChrome({
        tabExists: true,
        debuggerAttached: false,
        perTab: new Map([
          [42, { exists: true, debuggerAttached: false, attachSucceeds: true }],
          [99, { exists: true, debuggerAttached: false, attachSucceeds: false }],
        ]),
      });
      const { tabs } = await desiredRehydrateState(chrome, entries);
      // Tab 42 re-attaches successfully, tab 99 fails
      expect(tabs.has(42)).toBe(true);
      expect(tabs.has(99)).toBe(false);
      expect(tabs.size).toBe(1);
      expect(chrome.attachCalls).toContain(42);
    });
  });

  describe("regression: ordering-dependent shared-state bug (quadricep audit)", () => {
    it("per-tab debugger state prevents cross-tab contamination", async () => {
      // This test catches the bug quadricep identified: if debuggerAttached is
      // a single shared boolean, attaching tab A sets it true globally, causing
      // tab B's validation to pass even though B's debugger was never re-attached.
      const entries: PersistedTab[] = [
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 1 },
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 2 },
      ];
      // Both tabs have detached debuggers, but only tab 42 can re-attach
      const chrome = createMockChrome({
        tabExists: true,
        debuggerAttached: false,
        perTab: new Map([
          [42, { exists: true, debuggerAttached: false, attachSucceeds: true }],
          [99, { exists: true, debuggerAttached: false, attachSucceeds: false }],
        ]),
      });
      const { tabs } = await desiredRehydrateState(chrome, entries);
      // Tab 42 should re-attach and survive
      expect(tabs.has(42)).toBe(true);
      // Tab 99 should NOT survive — its re-attach fails independently
      // With the old shared boolean, tab 99 would pass because tab 42's
      // attach set the global flag to true
      expect(tabs.has(99)).toBe(false);
      // Verify attach was attempted for both
      expect(chrome.attachCalls).toContain(42);
    });
  });

  describe("regression: the MV3 worker restart scenario", () => {
    it("demonstrates the full failure path that causes relay drops", async () => {
      // Scenario: User has tab 42 attached and working. MV3 worker restarts.
      // chrome.storage.session still has the persisted tab entry.
      // But chrome.debugger session is gone.

      const chrome = createMockChrome({ tabExists: true, debuggerAttached: false });

      // Step 1: Current code restores tab optimistically
      // Step 2: Current code validates — finds debugger detached
      // Step 3: Current code DELETES the tab
      const currentResult = await currentRehydrateState(chrome, [persistedTab]);
      expect(currentResult.tabs.size).toBe(0); // ← The bug: tab vanishes

      // Reset mock for desired behavior test
      const chrome2 = createMockChrome({
        tabExists: true,
        debuggerAttached: false,
        attachSucceeds: true,
      });

      // Step 1: Desired code restores tab optimistically
      // Step 2: Desired code validates — finds debugger detached
      // Step 3: Desired code RE-ATTACHES the debugger
      // Step 4: Desired code validates again — now succeeds
      const desiredResult = await desiredRehydrateState(chrome2, [persistedTab]);
      expect(desiredResult.tabs.size).toBe(1); // ← The fix: tab survives
      expect(chrome2.attachCalls).toEqual([42]); // debugger was re-attached
    });
  });
});
