/**
 * Tests for two additional coverage gaps in chrome extension MV3 rehydration:
 *
 * Gap 2 (MEDIUM): `reannounceAttachedTabs` — WebSocket reconnect path
 *   After relay WebSocket reconnect (background.js lines 293-310), this function
 *   validates each tab and deletes on failure — same delete-without-reattach bug
 *   as `rehydrateState`. Third separate code path that drops tabs.
 *
 * Gap 3 (LOW): `tabOperationLocks` — concurrency guard
 *   Production `attachTab()` uses a Set<number> lock that silently drops re-attach
 *   when the lock is held. Previous test suites call `chrome.debugger.attach()`
 *   directly, bypassing this guard. Must prove: concurrent re-attach on same tab
 *   gets silently dropped.
 *
 * Obligation: obl-reannounce-tablocks
 * Authored by quadricep.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── Types ───────────────────────────────────────────────────────────────

type TabState = {
  state: string;
  sessionId: string;
  targetId: string;
  attachOrder?: number;
};

type PerTabState = {
  exists: boolean;
  debuggerAttached: boolean;
  attachSucceeds: boolean;
  /** Simulates attach taking time (ms) — for concurrency tests */
  attachDelayMs?: number;
};

// ── Mock Chrome APIs (closure-captured store, no this-binding) ──────────

function createMockChrome(tabStates: Map<number, PerTabState>) {
  const attachCalls: number[] = [];
  const detachCalls: number[] = [];

  // Closure-captured store — no this-binding fragility
  const sessionStore: Record<string, unknown> = {};

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
        // Simulate async delay if configured (for concurrency tests)
        if (state.attachDelayMs && state.attachDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.attachDelayMs));
        }
        attachCalls.push(debuggee.tabId);
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
        get: vi.fn(async (keys?: string[]) => {
          if (!keys) {
            return { ...sessionStore };
          }
          const result: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in sessionStore) {
              result[k] = sessionStore[k];
            }
          }
          return result;
        }),
        set: vi.fn(async (data: Record<string, unknown>) => {
          Object.assign(sessionStore, data);
        }),
      },
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setBadgeTextColor: vi.fn(async () => {}),
    },
    attachCalls,
    detachCalls,
    // Expose for direct store manipulation in tests
    _sessionStore: sessionStore,
  };
}

type MockChrome = ReturnType<typeof createMockChrome>;

// ── Shared validation logic ─────────────────────────────────────────────

const TAB_VALIDATION_ATTEMPTS = 2;

async function validateAttachedTab(chrome: MockChrome, tabId: number): Promise<boolean> {
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
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// GAP 2: reannounceAttachedTabs — WebSocket reconnect path
// ═══════════════════════════════════════════════════════════════════════

/**
 * Models the current `reannounceAttachedTabs` from background.js (lines 293-310).
 * Called after relay WebSocket reconnects. Iterates all tracked tabs, validates
 * each, and re-announces valid ones to the relay. Deletes invalid ones.
 *
 * BUG: Same delete-without-reattach pattern as the original rehydrateState.
 * If debugger detached (e.g., after MV3 restart that also killed WS), tab is
 * deleted even though it still exists and could be re-attached.
 */
async function currentReannounceAttachedTabs(
  chrome: MockChrome,
  tabs: Map<number, TabState>,
  tabBySession: Map<string, number>,
  relay: { send: (msg: unknown) => void },
): Promise<{ announced: number[]; deleted: number[] }> {
  const announced: number[] = [];
  const deleted: number[] = [];

  for (const [tabId, tabState] of tabs) {
    const valid = await validateAttachedTab(chrome, tabId);
    if (valid) {
      // Re-announce to relay
      relay.send({
        type: "tab-attached",
        tabId,
        sessionId: tabState.sessionId,
        targetId: tabState.targetId,
      });
      announced.push(tabId);
    } else {
      // BUG: Delete without attempting re-attach
      tabs.delete(tabId);
      tabBySession.delete(tabState.sessionId);
      deleted.push(tabId);
    }
  }

  return { announced, deleted };
}

/**
 * Fixed `reannounceAttachedTabs`: attempts re-attach before deleting.
 */
async function fixedReannounceAttachedTabs(
  chrome: MockChrome,
  tabs: Map<number, TabState>,
  tabBySession: Map<string, number>,
  relay: { send: (msg: unknown) => void },
): Promise<{ announced: number[]; deleted: number[]; reattached: number[] }> {
  const announced: number[] = [];
  const deleted: number[] = [];
  const reattached: number[] = [];

  for (const [tabId, tabState] of tabs) {
    const valid = await validateAttachedTab(chrome, tabId);
    if (valid) {
      relay.send({
        type: "tab-attached",
        tabId,
        sessionId: tabState.sessionId,
        targetId: tabState.targetId,
      });
      announced.push(tabId);
    } else {
      // FIX: Try re-attach before deleting
      try {
        await chrome.tabs.get(tabId); // Tab still exists?
        await chrome.debugger.attach({ tabId }, "1.3");
        const validAfter = await validateAttachedTab(chrome, tabId);
        if (validAfter) {
          relay.send({
            type: "tab-attached",
            tabId,
            sessionId: tabState.sessionId,
            targetId: tabState.targetId,
          });
          announced.push(tabId);
          reattached.push(tabId);
          continue;
        }
      } catch {
        // Tab gone or attach failed
      }
      tabs.delete(tabId);
      tabBySession.delete(tabState.sessionId);
      deleted.push(tabId);
    }
  }

  return { announced, deleted, reattached };
}

// ═══════════════════════════════════════════════════════════════════════
// GAP 3: tabOperationLocks — concurrency guard
// ═══════════════════════════════════════════════════════════════════════

/**
 * Models the production `attachTab()` with `tabOperationLocks`.
 * In background.js, `attachTab()` checks a Set<number> before starting
 * the attach flow. If the tabId is already in the set, the operation
 * is silently dropped — no error, no retry, no feedback.
 */
function createTabOperationLocks() {
  const locks = new Set<number>();

  return {
    /**
     * attachTab with lock guard — models production behavior.
     * Returns false if lock was held (operation dropped).
     */
    async attachTab(
      chrome: MockChrome,
      tabId: number,
      tabs: Map<number, TabState>,
      tabBySession: Map<string, number>,
      sessionId: string,
      targetId: string,
    ): Promise<{ attached: boolean; droppedByLock: boolean }> {
      if (locks.has(tabId)) {
        // SILENTLY DROPPED — no error, no retry, no log
        return { attached: false, droppedByLock: true };
      }

      locks.add(tabId);
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
        const valid = await validateAttachedTab(chrome, tabId);
        if (valid) {
          tabs.set(tabId, {
            state: "connected",
            sessionId,
            targetId,
          });
          tabBySession.set(sessionId, tabId);
          return { attached: true, droppedByLock: false };
        }
        return { attached: false, droppedByLock: false };
      } catch {
        return { attached: false, droppedByLock: false };
      } finally {
        locks.delete(tabId);
      }
    },

    /** Check if a tab is currently locked */
    isLocked(tabId: number): boolean {
      return locks.has(tabId);
    },

    /** Expose the lock set for assertions */
    get locksSet(): Set<number> {
      return locks;
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("Gap 2: reannounceAttachedTabs — WebSocket reconnect path (obl-reannounce-tablocks)", () => {
  describe("current behavior: delete-without-reattach on WS reconnect", () => {
    it("BUG: deletes tab with detached debugger instead of re-attaching", async () => {
      const tabStates = new Map<number, PerTabState>([
        [42, { exists: true, debuggerAttached: false, attachSucceeds: true }],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "t-42" }],
      ]);
      const tabBySession = new Map<string, number>([["cb-tab-42", 42]]);
      const relay = { send: vi.fn() };

      const result = await currentReannounceAttachedTabs(chrome, tabs, tabBySession, relay);

      // BUG: Tab deleted without re-attach attempt
      expect(result.deleted).toEqual([42]);
      expect(result.announced).toEqual([]);
      expect(tabs.has(42)).toBe(false);
      expect(chrome.attachCalls).toHaveLength(0); // Never tried to re-attach
      expect(relay.send).not.toHaveBeenCalled(); // Never re-announced
    });

    it("announces tabs with attached debugger (happy path)", async () => {
      const tabStates = new Map<number, PerTabState>([
        [42, { exists: true, debuggerAttached: true, attachSucceeds: true }],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "t-42" }],
      ]);
      const tabBySession = new Map<string, number>([["cb-tab-42", 42]]);
      const relay = { send: vi.fn() };

      const result = await currentReannounceAttachedTabs(chrome, tabs, tabBySession, relay);

      expect(result.announced).toEqual([42]);
      expect(result.deleted).toEqual([]);
      expect(tabs.has(42)).toBe(true);
      expect(relay.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tab-attached", tabId: 42 }),
      );
    });

    it("correctly deletes genuinely gone tab", async () => {
      const tabStates = new Map<number, PerTabState>([
        [42, { exists: false, debuggerAttached: false, attachSucceeds: false }],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "t-42" }],
      ]);
      const tabBySession = new Map<string, number>([["cb-tab-42", 42]]);
      const relay = { send: vi.fn() };

      const result = await currentReannounceAttachedTabs(chrome, tabs, tabBySession, relay);

      expect(result.deleted).toEqual([42]);
      expect(tabs.has(42)).toBe(false);
    });

    it("BUG: mixed tabs — announces attached, deletes detached without re-attach", async () => {
      const tabStates = new Map<number, PerTabState>([
        [42, { exists: true, debuggerAttached: true, attachSucceeds: true }],
        [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
        [150, { exists: false, debuggerAttached: false, attachSucceeds: false }],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "t-42" }],
        [99, { state: "connected", sessionId: "cb-tab-99", targetId: "t-99" }],
        [150, { state: "connected", sessionId: "cb-tab-150", targetId: "t-150" }],
      ]);
      const tabBySession = new Map<string, number>([
        ["cb-tab-42", 42],
        ["cb-tab-99", 99],
        ["cb-tab-150", 150],
      ]);
      const relay = { send: vi.fn() };

      const result = await currentReannounceAttachedTabs(chrome, tabs, tabBySession, relay);

      // Tab 42: announced (debugger attached)
      expect(result.announced).toContain(42);
      // Tab 99: deleted without re-attach (BUG — tab exists, debugger detached)
      expect(result.deleted).toContain(99);
      // Tab 150: correctly deleted (tab gone)
      expect(result.deleted).toContain(150);
      expect(chrome.attachCalls).toHaveLength(0); // Never tried re-attach for 99
      expect(tabs.size).toBe(1);
    });
  });

  describe("fixed behavior: re-attach before deleting on WS reconnect", () => {
    it("FIX: re-attaches tab with detached debugger on WS reconnect", async () => {
      const tabStates = new Map<number, PerTabState>([
        [42, { exists: true, debuggerAttached: false, attachSucceeds: true }],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "t-42" }],
      ]);
      const tabBySession = new Map<string, number>([["cb-tab-42", 42]]);
      const relay = { send: vi.fn() };

      const result = await fixedReannounceAttachedTabs(chrome, tabs, tabBySession, relay);

      // Tab re-attached and announced
      expect(result.reattached).toEqual([42]);
      expect(result.announced).toContain(42);
      expect(result.deleted).toEqual([]);
      expect(tabs.has(42)).toBe(true);
      expect(chrome.attachCalls).toContain(42);
      expect(relay.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tab-attached", tabId: 42 }),
      );
    });

    it("FIX: still deletes if re-attach fails", async () => {
      const tabStates = new Map<number, PerTabState>([
        [42, { exists: true, debuggerAttached: false, attachSucceeds: false }],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "t-42" }],
      ]);
      const tabBySession = new Map<string, number>([["cb-tab-42", 42]]);
      const relay = { send: vi.fn() };

      const result = await fixedReannounceAttachedTabs(chrome, tabs, tabBySession, relay);

      expect(result.deleted).toEqual([42]);
      expect(result.reattached).toEqual([]);
      expect(tabs.has(42)).toBe(false);
    });

    it("FIX: mixed tabs — announces attached, re-attaches detached, deletes gone", async () => {
      const tabStates = new Map<number, PerTabState>([
        [42, { exists: true, debuggerAttached: true, attachSucceeds: true }],
        [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
        [150, { exists: false, debuggerAttached: false, attachSucceeds: false }],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "t-42" }],
        [99, { state: "connected", sessionId: "cb-tab-99", targetId: "t-99" }],
        [150, { state: "connected", sessionId: "cb-tab-150", targetId: "t-150" }],
      ]);
      const tabBySession = new Map<string, number>([
        ["cb-tab-42", 42],
        ["cb-tab-99", 99],
        ["cb-tab-150", 150],
      ]);
      const relay = { send: vi.fn() };

      const result = await fixedReannounceAttachedTabs(chrome, tabs, tabBySession, relay);

      // Tab 42: announced directly (debugger was attached)
      expect(result.announced).toContain(42);
      // Tab 99: re-attached then announced
      expect(result.reattached).toContain(99);
      expect(result.announced).toContain(99);
      // Tab 150: deleted (genuinely gone)
      expect(result.deleted).toContain(150);
      expect(tabs.size).toBe(2);
      expect(chrome.attachCalls).toEqual([99]); // Only 99 needed re-attach
    });
  });

  describe("interaction: WS reconnect + MV3 restart double failure", () => {
    it("WS reconnect after MV3 restart: all tabs have detached debuggers", async () => {
      // Scenario: MV3 worker restarts, then WS reconnects.
      // All debugger sessions are dead. reannounceAttachedTabs runs.
      const tabStates = new Map<number, PerTabState>([
        [42, { exists: true, debuggerAttached: false, attachSucceeds: true }],
        [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "t-42" }],
        [99, { state: "connected", sessionId: "cb-tab-99", targetId: "t-99" }],
      ]);
      const tabBySession = new Map<string, number>([
        ["cb-tab-42", 42],
        ["cb-tab-99", 99],
      ]);
      const relay = { send: vi.fn() };

      // Current behavior: all tabs deleted
      const bugResult = await currentReannounceAttachedTabs(chrome, tabs, tabBySession, relay);
      expect(bugResult.deleted).toEqual([42, 99]);
      expect(tabs.size).toBe(0);

      // Reset for fixed behavior
      const chrome2 = createMockChrome(
        new Map<number, PerTabState>([
          [42, { exists: true, debuggerAttached: false, attachSucceeds: true }],
          [99, { exists: true, debuggerAttached: false, attachSucceeds: true }],
        ]),
      );
      const tabs2 = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "t-42" }],
        [99, { state: "connected", sessionId: "cb-tab-99", targetId: "t-99" }],
      ]);
      const tabBySession2 = new Map<string, number>([
        ["cb-tab-42", 42],
        ["cb-tab-99", 99],
      ]);
      const relay2 = { send: vi.fn() };

      // Fixed behavior: all tabs re-attached and announced
      const fixResult = await fixedReannounceAttachedTabs(chrome2, tabs2, tabBySession2, relay2);
      expect(fixResult.reattached).toEqual([42, 99]);
      expect(fixResult.announced).toEqual([42, 99]);
      expect(tabs2.size).toBe(2);
    });
  });
});

describe("Gap 3: tabOperationLocks — concurrency guard (obl-reannounce-tablocks)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("lock behavior", () => {
    it("first attach acquires lock and succeeds", async () => {
      const tabStates = new Map<number, PerTabState>([
        [42, { exists: true, debuggerAttached: false, attachSucceeds: true }],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>();
      const tabBySession = new Map<string, number>();
      const locks = createTabOperationLocks();

      const result = await locks.attachTab(chrome, 42, tabs, tabBySession, "cb-tab-42", "t-42");

      expect(result.attached).toBe(true);
      expect(result.droppedByLock).toBe(false);
      expect(tabs.has(42)).toBe(true);
      expect(chrome.attachCalls).toContain(42);
      // Lock is released after completion
      expect(locks.isLocked(42)).toBe(false);
    });

    it("BUG: concurrent attach on same tab is silently dropped", async () => {
      const tabStates = new Map<number, PerTabState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            attachDelayMs: 100, // Slow attach to create race window
          },
        ],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>();
      const tabBySession = new Map<string, number>();
      const locks = createTabOperationLocks();

      // First attach starts (slow — 100ms)
      const attach1Promise = locks.attachTab(chrome, 42, tabs, tabBySession, "cb-tab-42", "t-42");

      // Lock is held
      expect(locks.isLocked(42)).toBe(true);

      // Second attach on same tab — silently dropped
      const result2 = await locks.attachTab(
        chrome,
        42,
        tabs,
        tabBySession,
        "cb-tab-42-dup",
        "t-42",
      );

      expect(result2.attached).toBe(false);
      expect(result2.droppedByLock).toBe(true);
      // No error thrown — silent drop is the bug

      // Let first attach complete
      await vi.advanceTimersByTimeAsync(100);
      const result1 = await attach1Promise;

      expect(result1.attached).toBe(true);
      expect(chrome.attachCalls).toEqual([42]); // Only one attach call made
    });

    it("lock on tab A does not block tab B", async () => {
      const tabStates = new Map<number, PerTabState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            attachDelayMs: 100,
          },
        ],
        [
          99,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
          },
        ],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>();
      const tabBySession = new Map<string, number>();
      const locks = createTabOperationLocks();

      // Start slow attach on tab 42
      const attach42Promise = locks.attachTab(chrome, 42, tabs, tabBySession, "cb-tab-42", "t-42");

      // Tab 42 locked, tab 99 is free
      expect(locks.isLocked(42)).toBe(true);
      expect(locks.isLocked(99)).toBe(false);

      // Attach tab 99 concurrently — should succeed immediately
      const result99 = await locks.attachTab(chrome, 99, tabs, tabBySession, "cb-tab-99", "t-99");

      expect(result99.attached).toBe(true);
      expect(result99.droppedByLock).toBe(false);

      // Complete tab 42
      await vi.advanceTimersByTimeAsync(100);
      const result42 = await attach42Promise;

      expect(result42.attached).toBe(true);
      expect(chrome.attachCalls).toEqual([99, 42]); // Both attached, 99 first (faster)
    });

    it("lock is released even when attach fails", async () => {
      const tabStates = new Map<number, PerTabState>([
        [42, { exists: true, debuggerAttached: false, attachSucceeds: false }],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>();
      const tabBySession = new Map<string, number>();
      const locks = createTabOperationLocks();

      const result = await locks.attachTab(chrome, 42, tabs, tabBySession, "cb-tab-42", "t-42");

      expect(result.attached).toBe(false);
      expect(result.droppedByLock).toBe(false);
      // Lock released despite failure — important for retry ability
      expect(locks.isLocked(42)).toBe(false);
    });
  });

  describe("interaction: locks + rehydrateState / navigation handler", () => {
    it("BUG: rehydrateState re-attach attempt dropped if lock held by concurrent operation", async () => {
      // Scenario: tab 42 is being attached by a user action (lock held).
      // MV3 worker doesn't restart, but rehydrateState runs (e.g., storage event).
      // rehydrateState tries to re-attach via attachTab — silently dropped by lock.
      // Tab ends up deleted even though the concurrent attach would have succeeded.

      const tabStates = new Map<number, PerTabState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            attachDelayMs: 200, // Slow attach simulating user action
          },
        ],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>();
      const tabBySession = new Map<string, number>();
      const locks = createTabOperationLocks();

      // User action starts attaching tab 42 (slow)
      const userAttachPromise = locks.attachTab(
        chrome,
        42,
        tabs,
        tabBySession,
        "cb-tab-42",
        "t-42",
      );

      // Lock is held
      expect(locks.isLocked(42)).toBe(true);

      // rehydrateState tries to re-attach the same tab via attachTab
      const rehydrateAttempt = await locks.attachTab(
        chrome,
        42,
        tabs,
        tabBySession,
        "cb-tab-42",
        "t-42",
      );

      // SILENTLY DROPPED — rehydrateState's re-attach never executes
      expect(rehydrateAttempt.droppedByLock).toBe(true);
      expect(rehydrateAttempt.attached).toBe(false);

      // Let user action complete
      await vi.advanceTimersByTimeAsync(200);
      const userResult = await userAttachPromise;

      // User action succeeded — but if rehydrateState had already deleted
      // the tab from its maps (before trying attachTab), the tab is gone
      // even though the attach eventually worked.
      expect(userResult.attached).toBe(true);
      expect(chrome.attachCalls).toEqual([42]); // Only one actual attach
    });

    it("BUG: navigation handler re-attach dropped if rehydrateState holds lock", async () => {
      // Reverse scenario: rehydrateState is in the middle of re-attaching tab 42
      // (lock held). Navigation handler also tries to re-attach the same tab.
      // Navigation handler's attempt is silently dropped.

      const tabStates = new Map<number, PerTabState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            attachDelayMs: 150,
          },
        ],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>();
      const tabBySession = new Map<string, number>();
      const locks = createTabOperationLocks();

      // rehydrateState starts attaching (slow)
      const rehydratePromise = locks.attachTab(chrome, 42, tabs, tabBySession, "cb-tab-42", "t-42");

      expect(locks.isLocked(42)).toBe(true);

      // Navigation handler also tries
      const navResult = await locks.attachTab(
        chrome,
        42,
        tabs,
        tabBySession,
        "cb-tab-42-nav",
        "t-42",
      );

      // Silently dropped
      expect(navResult.droppedByLock).toBe(true);

      // Let rehydrateState finish
      await vi.advanceTimersByTimeAsync(150);
      const rehydrateResult = await rehydratePromise;

      expect(rehydrateResult.attached).toBe(true);
      // Only one attach call — nav handler's was dropped
      expect(chrome.attachCalls).toEqual([42]);
    });

    it("FIX path: lock-aware caller should defer or retry instead of dropping", async () => {
      // The fix: instead of silently dropping when lock is held,
      // the caller should either:
      // a) wait for the lock to release and check the result, or
      // b) return a "locked" status so the caller can retry

      const tabStates = new Map<number, PerTabState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            attachDelayMs: 100,
          },
        ],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>();
      const tabBySession = new Map<string, number>();
      const locks = createTabOperationLocks();

      // First attach starts
      const firstPromise = locks.attachTab(chrome, 42, tabs, tabBySession, "cb-tab-42", "t-42");

      // Second caller gets droppedByLock: true
      const secondResult = await locks.attachTab(
        chrome,
        42,
        tabs,
        tabBySession,
        "cb-tab-42",
        "t-42",
      );
      expect(secondResult.droppedByLock).toBe(true);

      // FIX: caller sees droppedByLock and waits instead of deleting
      // After first completes, tab is in the map
      await vi.advanceTimersByTimeAsync(100);
      await firstPromise;

      // Now the caller can check: is the tab actually in the map?
      // If yes, the concurrent operation succeeded — don't delete.
      expect(tabs.has(42)).toBe(true);

      // The key insight: the current code doesn't check tabs after
      // getting a lock rejection. It just proceeds to delete.
      // The fix is: if droppedByLock, check tabs.has(tabId) after
      // a short delay instead of immediately deleting.
    });
  });

  describe("interaction: locks + reannounceAttachedTabs", () => {
    it("BUG: WS reconnect re-announce races with ongoing user attach", async () => {
      // User is attaching tab 42 (lock held).
      // WS reconnects and reannounceAttachedTabs runs.
      // Tab 42 is in the tabs map but validation fails (debugger not yet attached).
      // reannounceAttachedTabs deletes tab 42 even though user attach is in progress.

      const tabStates = new Map<number, PerTabState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            attachDelayMs: 200,
          },
        ],
      ]);
      const chrome = createMockChrome(tabStates);
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "t-42" }],
      ]);
      const tabBySession = new Map<string, number>([["cb-tab-42", 42]]);
      const locks = createTabOperationLocks();
      const relay = { send: vi.fn() };

      // User starts attaching tab 42
      const userPromise = locks.attachTab(chrome, 42, tabs, tabBySession, "cb-tab-42", "t-42");

      // WS reconnects mid-attach — reannounceAttachedTabs runs
      // It validates tab 42, finds debugger detached (user attach not done yet)
      const reannounceResult = await currentReannounceAttachedTabs(
        chrome,
        tabs,
        tabBySession,
        relay,
      );

      // BUG: Tab deleted by reannounce even though user attach is in progress
      expect(reannounceResult.deleted).toContain(42);
      expect(tabs.has(42)).toBe(false);

      // User attach completes — but the tab is already gone from the map
      await vi.advanceTimersByTimeAsync(200);
      const _userResult = await userAttachPromiseComplete(userPromise);

      // The debugger IS attached now, but the tab map was already cleaned
      expect(tabStates.get(42)!.debuggerAttached).toBe(true);
      // Tab is in the map again only because attachTab re-added it
      // But the relay was never told — the reannounce already ran
    });
  });
});

/** Helper: resolve a locked attachTab promise */
async function userAttachPromiseComplete(
  promise: Promise<{ attached: boolean; droppedByLock: boolean }>,
): Promise<{ attached: boolean; droppedByLock: boolean }> {
  return promise;
}
