/**
 * Navigation re-attach + MV3 worker restart race condition tests.
 *
 * Obligation: obl-nav-reattach-race
 * Gap: background.js lines 790-879 implement a separate re-attach flow via
 * `onBeforeNavigate` with 5-attempt exponential backoff [200,500,1000,2000,4000]ms.
 * If MV3 worker restarts mid-navigation:
 *   1. `reattachPending` (in-memory Set) is cleared
 *   2. `chrome.storage.session` still has the tab
 *   3. `rehydrateState` loads it, validates immediately (no backoff)
 *   4. Validation fails because page is still loading → tab deleted
 *   5. Navigation handler would have saved it with backoff, but it's gone
 *
 * The race: rehydrateState (no backoff) vs onBeforeNavigate (with backoff)
 * firing on the same tab after a worker restart mid-navigation.
 *
 * Timer mocking via vi.useFakeTimers(). No real delays.
 *
 * Authored by quadricep for obl-nav-reattach-race.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── Types ───────────────────────────────────────────────────────────────

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

// ── Navigation-aware mock Chrome APIs ───────────────────────────────────

type TabNavState = {
  exists: boolean;
  debuggerAttached: boolean;
  attachSucceeds: boolean;
  /** Simulates page loading during navigation — debugger can't evaluate */
  pageLoading: boolean;
};

function createNavMockChrome(tabStates: Map<number, TabNavState>) {
  const attachCalls: number[] = [];
  const detachCalls: number[] = [];

  return {
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const state = tabStates.get(tabId);
        if (!state || !state.exists) {
          throw new Error(`No tab with id: ${tabId}`);
        }
        return {
          id: tabId,
          url: "https://example.com",
          status: state.pageLoading ? "loading" : "complete",
        };
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
            if (state.pageLoading) {
              // During navigation, Runtime.evaluate fails even with debugger attached
              throw new Error("Cannot evaluate: page is being navigated");
            }
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
        _store: {} as Record<string, unknown>,
        get: vi.fn(async function (this: { _store: Record<string, unknown> }, keys?: string[]) {
          if (!keys) {
            return { ...this._store };
          }
          const result: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in this._store) {
              result[k] = this._store[k];
            }
          }
          return result;
        }),
        set: vi.fn(async function (
          this: { _store: Record<string, unknown> },
          data: Record<string, unknown>,
        ) {
          Object.assign(this._store, data);
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
  };
}

type MockChrome = ReturnType<typeof createNavMockChrome>;

// ── Production-modeled logic ────────────────────────────────────────────

const TAB_VALIDATION_ATTEMPTS = 2;
const BACKOFF_DELAYS = [200, 500, 1000, 2000, 4000]; // ms

/**
 * validateAttachedTab — same as production.
 * Returns true only if tab exists AND debugger sendCommand succeeds.
 */
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

/**
 * Models the navigation re-attach handler from background.js (lines 790-879).
 * Uses exponential backoff to re-attach debugger during navigation.
 * Tracks pending re-attaches in an in-memory Set.
 */
async function navigationReattachHandler(
  chrome: MockChrome,
  tabId: number,
  reattachPending: Set<number>,
  tabs: Map<number, TabState>,
  tabBySession: Map<string, number>,
  sessionId: string,
): Promise<boolean> {
  if (reattachPending.has(tabId)) {
    return false; // Already being handled
  }
  reattachPending.add(tabId);

  try {
    for (let attempt = 0; attempt < BACKOFF_DELAYS.length; attempt++) {
      // Wait with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_DELAYS[attempt]));

      // Check if tab still exists
      try {
        await chrome.tabs.get(tabId);
      } catch {
        // Tab gone — clean up
        tabs.delete(tabId);
        tabBySession.delete(sessionId);
        return false;
      }

      // Check if tab was already deleted by rehydrateState while we were waiting
      if (!tabs.has(tabId)) {
        return false; // rehydrateState already cleaned this up
      }

      // Try to attach debugger
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch {
        continue; // Retry with next backoff
      }

      // Validate after attach
      const valid = await validateAttachedTab(chrome, tabId);
      if (valid) {
        return true; // Success!
      }
    }

    // All attempts exhausted — delete tab
    tabs.delete(tabId);
    tabBySession.delete(sessionId);
    return false;
  } finally {
    reattachPending.delete(tabId);
  }
}

/**
 * rehydrateState — current production behavior.
 * Loads from chrome.storage.session, validates immediately, deletes on failure.
 * Does NOT check reattachPending. Does NOT use backoff.
 */
async function rehydrateState(
  chrome: MockChrome,
  entries: PersistedTab[],
): Promise<{ tabs: Map<number, TabState>; tabBySession: Map<string, number> }> {
  const tabs = new Map<number, TabState>();
  const tabBySession = new Map<string, number>();

  // Phase 1: optimistically restore from storage
  for (const entry of entries) {
    tabs.set(entry.tabId, {
      state: "connected",
      sessionId: entry.sessionId,
      targetId: entry.targetId,
      attachOrder: entry.attachOrder,
    });
    tabBySession.set(entry.sessionId, entry.tabId);
  }

  // Phase 2: validate immediately — NO backoff, NO check for pending re-attach
  for (const entry of entries) {
    const valid = await validateAttachedTab(chrome, entry.tabId);
    if (!valid) {
      tabs.delete(entry.tabId);
      tabBySession.delete(entry.sessionId);
    }
  }

  return { tabs, tabBySession };
}

/**
 * rehydrateState — backoff-aware fix.
 * Checks reattachPending before deleting. If a navigation handler is actively
 * trying to re-attach this tab with backoff, defers to it instead of deleting.
 */
async function rehydrateStateBackoffAware(
  chrome: MockChrome,
  entries: PersistedTab[],
  reattachPending: Set<number>,
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
      // FIX: Check if navigation handler is actively trying to re-attach
      if (reattachPending.has(entry.tabId)) {
        // Defer to the navigation handler — don't delete yet
        continue;
      }
      tabs.delete(entry.tabId);
      tabBySession.delete(entry.sessionId);
    }
  }

  return { tabs, tabBySession };
}

/**
 * rehydrateState — persistent-pending fix.
 * Even after worker restart clears in-memory reattachPending, this version
 * checks chrome.storage.session for a persisted pending set.
 */
async function rehydrateStateWithPersistedPending(
  chrome: MockChrome,
  entries: PersistedTab[],
): Promise<{ tabs: Map<number, TabState>; tabBySession: Map<string, number> }> {
  const tabs = new Map<number, TabState>();
  const tabBySession = new Map<string, number>();

  // Load persisted pending set from storage (survives worker restart)
  const stored = await chrome.storage.session.get(["reattachPending"]);
  const persistedPending = new Set<number>((stored.reattachPending as number[] | undefined) ?? []);

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
      if (persistedPending.has(entry.tabId)) {
        // Tab was mid-navigation when worker restarted — don't delete,
        // instead attempt re-attach with backoff
        try {
          await chrome.debugger.attach({ tabId: entry.tabId }, "1.3");
          const validAfter = await validateAttachedTab(chrome, entry.tabId);
          if (validAfter) {
            continue;
          }
        } catch {
          // Fall through to delete
        }
      }
      tabs.delete(entry.tabId);
      tabBySession.delete(entry.sessionId);
    }
  }

  return { tabs, tabBySession };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("navigation re-attach + MV3 worker restart race (obl-nav-reattach-race)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const persistedTab: PersistedTab = {
    tabId: 42,
    sessionId: "cb-tab-42",
    targetId: "target-42",
    attachOrder: 1,
  };

  describe("navigation handler: exponential backoff re-attach", () => {
    it("successfully re-attaches after page finishes loading", async () => {
      const tabStates = new Map<number, TabNavState>([
        [42, { exists: true, debuggerAttached: false, attachSucceeds: true, pageLoading: true }],
      ]);
      const chrome = createNavMockChrome(tabStates);
      const reattachPending = new Set<number>();
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "target-42" }],
      ]);
      const tabBySession = new Map<string, number>([["cb-tab-42", 42]]);

      // Start the navigation handler (non-blocking)
      const handlerPromise = navigationReattachHandler(
        chrome,
        42,
        reattachPending,
        tabs,
        tabBySession,
        "cb-tab-42",
      );

      // Tab is in pending set immediately
      expect(reattachPending.has(42)).toBe(true);

      // First attempt at 200ms — page still loading, attach succeeds but validate fails
      await vi.advanceTimersByTimeAsync(200);

      // Page finishes loading before second attempt
      tabStates.get(42)!.pageLoading = false;

      // Second attempt at 500ms — now page is loaded, attach + validate succeed
      await vi.advanceTimersByTimeAsync(500);

      const result = await handlerPromise;
      expect(result).toBe(true);
      expect(tabs.has(42)).toBe(true);
      expect(reattachPending.has(42)).toBe(false); // Cleaned up
      expect(chrome.attachCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("uses correct backoff delays: [200, 500, 1000, 2000, 4000]ms", async () => {
      const tabStates = new Map<number, TabNavState>([
        [42, { exists: true, debuggerAttached: false, attachSucceeds: false, pageLoading: true }],
      ]);
      const chrome = createNavMockChrome(tabStates);
      const reattachPending = new Set<number>();
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "target-42" }],
      ]);
      const tabBySession = new Map<string, number>([["cb-tab-42", 42]]);

      const handlerPromise = navigationReattachHandler(
        chrome,
        42,
        reattachPending,
        tabs,
        tabBySession,
        "cb-tab-42",
      );

      // Advance through all backoff delays: 200+500+1000+2000+4000 = 7700ms
      for (const delay of BACKOFF_DELAYS) {
        await vi.advanceTimersByTimeAsync(delay);
      }

      const result = await handlerPromise;
      expect(result).toBe(false); // All attempts failed
      expect(tabs.has(42)).toBe(false); // Tab deleted after exhausting retries
      expect(reattachPending.has(42)).toBe(false); // Cleaned up
    });
  });

  describe("THE RACE: rehydrateState vs navigation handler", () => {
    it("BUG: rehydrateState deletes tab that navigation handler would have saved", async () => {
      // Scenario:
      // 1. Tab 42 is attached and user navigates to a new page
      // 2. Navigation handler starts backoff re-attach (tab is in reattachPending)
      // 3. MV3 worker restarts mid-navigation
      // 4. reattachPending (in-memory Set) is CLEARED
      // 5. chrome.storage.session still has tab 42
      // 6. rehydrateState fires, validates immediately — fails (page loading, debugger detached)
      // 7. Tab 42 is DELETED
      // 8. If navigation handler had been allowed to finish, it would have saved the tab

      const tabStates = new Map<number, TabNavState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false, // Lost on worker restart
            attachSucceeds: true, // WOULD succeed if given time
            pageLoading: true, // Still navigating
          },
        ],
      ]);
      const chrome = createNavMockChrome(tabStates);

      // Step 1-2: Navigation was in progress (reattachPending had tab 42)
      // Step 3: Worker restarts — reattachPending is CLEARED (fresh Set)
      const _reattachPendingAfterRestart = new Set<number>(); // Empty! Lost on restart

      // Step 4: chrome.storage.session still has the tab
      const storedEntries = [persistedTab];

      // Step 5: rehydrateState fires immediately (no backoff)
      const { tabs, tabBySession } = await rehydrateState(chrome, storedEntries);

      // THE BUG: Tab 42 is deleted because validation fails immediately
      // - debugger is detached (lost on restart)
      // - page is still loading (Runtime.evaluate would fail even if attached)
      // - rehydrateState doesn't know about the pending navigation
      // - rehydrateState doesn't use backoff
      expect(tabs.has(42)).toBe(false); // ← PREMATURE DELETION
      expect(tabBySession.has("cb-tab-42")).toBe(false);
      expect(chrome.attachCalls).toHaveLength(0); // Never even tried to re-attach

      // Prove the tab WOULD have been saveable:
      // If we give it time and re-attach, validation succeeds
      tabStates.get(42)!.pageLoading = false;
      tabStates.get(42)!.debuggerAttached = false;
      await chrome.debugger.attach({ tabId: 42 }, "1.3");
      const wouldHaveBeenValid = await validateAttachedTab(chrome, 42);
      expect(wouldHaveBeenValid).toBe(true); // ← The tab was saveable!
    });

    it("BUG: race window — nav handler is mid-backoff when rehydrateState fires", async () => {
      // More precise race:
      // Navigation handler started at T=0 with first backoff of 200ms.
      // Worker restarts at T=100ms (mid-backoff).
      // rehydrateState fires at T=100ms.
      // Navigation handler's setTimeout is gone (worker restarted).
      // rehydrateState validates immediately → fails → deletes.

      const tabStates = new Map<number, TabNavState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            pageLoading: true,
          },
        ],
      ]);
      const chrome = createNavMockChrome(tabStates);
      const reattachPending = new Set<number>();
      const tabs = new Map<number, TabState>([
        [42, { state: "connected", sessionId: "cb-tab-42", targetId: "target-42" }],
      ]);
      const tabBySession = new Map<string, number>([["cb-tab-42", 42]]);

      // T=0: Navigation handler starts
      const navPromise = navigationReattachHandler(
        chrome,
        42,
        reattachPending,
        tabs,
        tabBySession,
        "cb-tab-42",
      );

      // T=0: Handler is waiting for first backoff (200ms)
      expect(reattachPending.has(42)).toBe(true);

      // T=100ms: Worker restart simulation
      // In production: all in-memory state is lost, timers are gone
      // The navigation handler's setTimeout(200ms) would be cancelled
      // rehydrateState would fire fresh

      // Simulate: advance only 100ms (nav handler hasn't fired yet)
      await vi.advanceTimersByTimeAsync(100);

      // The key insight: at this point the navigation handler is waiting
      // in a setTimeout. In a real worker restart, this timer is LOST.
      // rehydrateState fires in a NEW worker context with empty reattachPending.

      // Create a fresh context (simulating worker restart)
      const _freshReattachPending = new Set<number>(); // EMPTY — in-memory state lost
      const freshChrome = createNavMockChrome(
        new Map<number, TabNavState>([
          [
            42,
            {
              exists: true,
              debuggerAttached: false, // Debugger session lost on restart
              attachSucceeds: true,
              pageLoading: true, // Page still navigating
            },
          ],
        ]),
      );

      // rehydrateState fires in the new worker — validates immediately
      const rehydrateResult = await rehydrateState(freshChrome, [persistedTab]);

      // Tab is deleted — rehydrateState didn't know about the pending navigation
      expect(rehydrateResult.tabs.has(42)).toBe(false);
      expect(freshChrome.attachCalls).toHaveLength(0);

      // Clean up the original nav handler (let it finish for test cleanup)
      // Advance remaining timers so the promise resolves
      await vi.advanceTimersByTimeAsync(BACKOFF_DELAYS.reduce((a, b) => a + b, 0));
      await navPromise;
    });

    it("BUG: reattachPending is in-memory only — not persisted to storage", async () => {
      // The root cause: reattachPending is a Set<number> in module scope.
      // It is NOT written to chrome.storage.session.
      // On worker restart, it's gone. rehydrateState can't consult it.

      const tabStates = new Map<number, TabNavState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            pageLoading: true,
          },
        ],
      ]);
      const chrome = createNavMockChrome(tabStates);

      // Simulate: tab was in reattachPending before restart
      const preRestartPending = new Set<number>([42]);
      expect(preRestartPending.has(42)).toBe(true);

      // Worker restarts — in-memory state is gone
      const postRestartPending = new Set<number>(); // Fresh, empty
      expect(postRestartPending.has(42)).toBe(false);

      // chrome.storage.session still has the tab entry though
      // (storage.session survives worker restart within a browser session)
      const storedEntries = [persistedTab];

      // rehydrateState has no way to know tab 42 was mid-navigation
      const { tabs } = await rehydrateState(chrome, storedEntries);
      expect(tabs.has(42)).toBe(false); // Deleted — the bug

      // Prove that if reattachPending were persisted, we could avoid this
      // (this sets up the fix path test below)
    });
  });

  describe("fix path: backoff-aware rehydrateState", () => {
    it("FIX (in-memory): defers to navigation handler when reattachPending is populated", async () => {
      // If the worker hasn't restarted, reattachPending is still populated.
      // The fixed rehydrateState checks it before deleting.

      const tabStates = new Map<number, TabNavState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            pageLoading: true,
          },
        ],
      ]);
      const chrome = createNavMockChrome(tabStates);
      const reattachPending = new Set<number>([42]); // Nav handler is active

      const { tabs, tabBySession } = await rehydrateStateBackoffAware(
        chrome,
        [persistedTab],
        reattachPending,
      );

      // Tab is NOT deleted — rehydrateState defers to the navigation handler
      expect(tabs.has(42)).toBe(true);
      expect(tabBySession.has("cb-tab-42")).toBe(true);
      // No attach attempted by rehydrateState — it trusts the nav handler
      expect(chrome.attachCalls).toHaveLength(0);
    });

    it("FIX (in-memory): still deletes when tab is not in reattachPending", async () => {
      const tabStates = new Map<number, TabNavState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            pageLoading: false,
          },
        ],
      ]);
      const chrome = createNavMockChrome(tabStates);
      const reattachPending = new Set<number>(); // Empty — no nav in progress

      const { tabs } = await rehydrateStateBackoffAware(chrome, [persistedTab], reattachPending);

      // Tab is deleted — no pending navigation to defer to
      expect(tabs.has(42)).toBe(false);
    });

    it("FIX (persisted): survives worker restart by reading pending set from storage", async () => {
      // The full fix: persist reattachPending to chrome.storage.session.
      // After worker restart, rehydrateState reads it back.

      const tabStates = new Map<number, TabNavState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            pageLoading: false, // Page finished loading by the time we retry
          },
        ],
      ]);
      const chrome = createNavMockChrome(tabStates);

      // Simulate: before restart, navigation handler persisted its pending set
      await chrome.storage.session.set({ reattachPending: [42] });

      // Worker restarts — in-memory state is lost, but storage survives
      // rehydrateStateWithPersistedPending reads from storage
      const { tabs, tabBySession } = await rehydrateStateWithPersistedPending(chrome, [
        persistedTab,
      ]);

      // Tab survives! The persisted pending set told rehydrateState to retry
      expect(tabs.has(42)).toBe(true);
      expect(tabBySession.has("cb-tab-42")).toBe(true);
      expect(chrome.attachCalls).toContain(42); // Re-attached via the fix path
    });

    it("FIX (persisted): still deletes if tab was pending but re-attach fails", async () => {
      const tabStates = new Map<number, TabNavState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: false, // Re-attach fails
            pageLoading: false,
          },
        ],
      ]);
      const chrome = createNavMockChrome(tabStates);

      // Tab was in persisted pending set
      await chrome.storage.session.set({ reattachPending: [42] });

      const { tabs } = await rehydrateStateWithPersistedPending(chrome, [persistedTab]);

      // Tab is correctly deleted — pending set gave it a chance, but attach failed
      expect(tabs.has(42)).toBe(false);
    });
  });

  describe("multi-tab: navigation race with mixed tab states", () => {
    it("tab A mid-navigation (would be saved), tab B genuinely dead — only A is premature", async () => {
      const entries: PersistedTab[] = [
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 1 },
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 2 },
      ];
      const tabStates = new Map<number, TabNavState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            pageLoading: true, // Mid-navigation — would be saved by handler
          },
        ],
        [
          99,
          {
            exists: false, // Tab genuinely gone
            debuggerAttached: false,
            attachSucceeds: false,
            pageLoading: false,
          },
        ],
      ]);
      const chrome = createNavMockChrome(tabStates);

      // Current (buggy) behavior: rehydrateState deletes both
      const { tabs } = await rehydrateState(chrome, entries);
      expect(tabs.has(42)).toBe(false); // WRONG — premature deletion
      expect(tabs.has(99)).toBe(false); // CORRECT — tab is genuinely gone

      // Prove tab 42 was saveable
      tabStates.get(42)!.pageLoading = false;
      tabStates.get(42)!.debuggerAttached = false;
      await chrome.debugger.attach({ tabId: 42 }, "1.3");
      expect(await validateAttachedTab(chrome, 42)).toBe(true);
    });

    it("FIX: persisted pending correctly saves A while deleting B", async () => {
      const entries: PersistedTab[] = [
        { tabId: 42, sessionId: "cb-tab-42", targetId: "t-42", attachOrder: 1 },
        { tabId: 99, sessionId: "cb-tab-99", targetId: "t-99", attachOrder: 2 },
      ];
      const tabStates = new Map<number, TabNavState>([
        [
          42,
          {
            exists: true,
            debuggerAttached: false,
            attachSucceeds: true,
            pageLoading: false, // Page loaded by retry time
          },
        ],
        [
          99,
          {
            exists: false,
            debuggerAttached: false,
            attachSucceeds: false,
            pageLoading: false,
          },
        ],
      ]);
      const chrome = createNavMockChrome(tabStates);

      // Tab 42 was mid-navigation — persisted to storage before restart
      await chrome.storage.session.set({ reattachPending: [42] });

      const { tabs } = await rehydrateStateWithPersistedPending(chrome, entries);

      // Tab 42 survives — persisted pending set triggered re-attach
      expect(tabs.has(42)).toBe(true);
      // Tab 99 correctly deleted — genuinely gone
      expect(tabs.has(99)).toBe(false);
      expect(chrome.attachCalls).toEqual([42]);
    });
  });
});
