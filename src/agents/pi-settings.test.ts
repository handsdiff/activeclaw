import { describe, expect, it, vi } from "vitest";
import {
  applyPiAdaptiveKeepRecentBudget,
  applyPiCompactionSettingsFromConfig,
  DEFAULT_PI_COMPACTION_DYNAMIC_KEEP_MARGIN_TOKENS,
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  MIN_PI_DYNAMIC_KEEP_RECENT_TOKENS,
  resolveCompactionReserveTokensFloor,
  resolveOverflowCompactionKeepRecentTokens,
} from "./pi-settings.js";

describe("applyPiCompactionSettingsFromConfig", () => {
  it("bumps reserveTokens when below floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({ settingsManager });

    expect(result.didOverride).toBe(true);
    expect(result.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("does not override when already above floor and not in safeguard mode", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 32_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "default" } } } },
    });

    expect(result.didOverride).toBe(false);
    expect(result.compaction.reserveTokens).toBe(32_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("applies explicit reserveTokens but still enforces floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 10_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokens: 12_000, reserveTokensFloor: 20_000 },
          },
        },
      },
    });

    expect(result.compaction.reserveTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 20_000 },
    });
  });

  it("applies keepRecentTokens when explicitly configured", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: {
              keepRecentTokens: 15_000,
            },
          },
        },
      },
    });

    expect(result.compaction.keepRecentTokens).toBe(15_000);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: 15_000 },
    });
  });

  it("preserves current keepRecentTokens when safeguard mode leaves it unset", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 25_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "safeguard" } } } },
    });

    expect(result.compaction.keepRecentTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("treats keepRecentTokens=0 as invalid and keeps the current setting", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 25_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "safeguard", keepRecentTokens: 0 } } } },
    });

    expect(result.compaction.keepRecentTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });
});

describe("resolveCompactionReserveTokensFloor", () => {
  it("returns the default when config is missing", () => {
    expect(resolveCompactionReserveTokensFloor()).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
  });

  it("accepts configured floors, including zero", () => {
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 24_000 } } },
      }),
    ).toBe(24_000);
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 0 } } },
      }),
    ).toBe(0);
  });
});

describe("applyPiAdaptiveKeepRecentBudget", () => {
  it("caps keepRecentTokens when the fixed prompt leaves too little history budget", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 80_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiAdaptiveKeepRecentBudget({
      settingsManager,
      contextWindowTokens: 128_000,
      systemPromptChars: 120_000,
      promptChars: 8_000,
    });

    expect(result.didOverride).toBe(true);
    expect(result.keepRecentTokens).toBe(64_000);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: 64_000 },
    });
  });

  it("does not override when the current keep budget already fits", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 24_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiAdaptiveKeepRecentBudget({
      settingsManager,
      contextWindowTokens: 128_000,
      systemPromptChars: 40_000,
      promptChars: 4_000,
    });

    expect(result.didOverride).toBe(false);
    expect(result.keepRecentTokens).toBe(24_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("never lowers keepRecentTokens below the emergency floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 60_000,
      getCompactionKeepRecentTokens: () => 10_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiAdaptiveKeepRecentBudget({
      settingsManager,
      contextWindowTokens: 70_000,
      systemPromptChars: 80_000,
      promptChars: 8_000,
      safetyMarginTokens: DEFAULT_PI_COMPACTION_DYNAMIC_KEEP_MARGIN_TOKENS,
    });

    expect(result.didOverride).toBe(true);
    expect(result.keepRecentTokens).toBe(MIN_PI_DYNAMIC_KEEP_RECENT_TOKENS);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: MIN_PI_DYNAMIC_KEEP_RECENT_TOKENS },
    });
  });

  it("accounts for prompt-image cost when capping keepRecentTokens", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 80_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiAdaptiveKeepRecentBudget({
      settingsManager,
      contextWindowTokens: 128_000,
      systemPromptChars: 120_000,
      promptChars: 8_000,
      promptImageCount: 2,
    });

    expect(result.didOverride).toBe(true);
    expect(result.estimatedPromptImageTokens).toBe(4_000);
    expect(result.keepRecentTokens).toBe(60_000);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: 60_000 },
    });
  });
});

describe("resolveOverflowCompactionKeepRecentTokens", () => {
  it("forces a materially smaller keep budget during overflow recovery", () => {
    expect(
      resolveOverflowCompactionKeepRecentTokens({
        contextWindowTokens: 200_000,
        currentKeepRecentTokens: 80_000,
        reserveTokens: 20_000,
        systemPromptChars: 124_000,
        promptChars: 360_000,
      }),
    ).toBe(24_500);
  });

  it("does not override when keepRecentTokens is already below the overflow cap", () => {
    expect(
      resolveOverflowCompactionKeepRecentTokens({
        contextWindowTokens: 200_000,
        currentKeepRecentTokens: 30_000,
        reserveTokens: 20_000,
        systemPromptChars: 124_000,
        promptChars: 16_000,
      }),
    ).toBeUndefined();
  });

  it("still forces the emergency floor when the prompt leaves no history budget", () => {
    expect(
      resolveOverflowCompactionKeepRecentTokens({
        contextWindowTokens: 80_000,
        currentKeepRecentTokens: 50_000,
        reserveTokens: 20_000,
        systemPromptChars: 120_000,
        promptChars: 40_000,
      }),
    ).toBe(8_000);
  });

  it("never exceeds a small positive remaining history budget during overflow recovery", () => {
    expect(
      resolveOverflowCompactionKeepRecentTokens({
        contextWindowTokens: 100_000,
        currentKeepRecentTokens: 50_000,
        reserveTokens: 20_000,
        systemPromptChars: 200_000,
        promptChars: 98_000,
      }),
    ).toBe(500);
  });

  it("accounts for prompt-image cost during overflow recovery", () => {
    expect(
      resolveOverflowCompactionKeepRecentTokens({
        contextWindowTokens: 200_000,
        currentKeepRecentTokens: 80_000,
        reserveTokens: 20_000,
        systemPromptChars: 124_000,
        promptChars: 360_000,
        promptImageCount: 2,
      }),
    ).toBe(22_500);
  });
});
