import type { OpenClawConfig } from "../config/config.js";
import type { ContextEngineInfo } from "../context-engine/types.js";

export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;
export const DEFAULT_PI_COMPACTION_DYNAMIC_KEEP_MARGIN_TOKENS = 12_000;
export const MIN_PI_DYNAMIC_KEEP_RECENT_TOKENS = 1_024;
export const DEFAULT_PI_PROMPT_IMAGE_TOKEN_ESTIMATE = 2_000;

type PiSettingsManagerLike = {
  getCompactionReserveTokens: () => number;
  getCompactionKeepRecentTokens: () => number;
  applyOverrides: (overrides: {
    compaction: {
      reserveTokens?: number;
      keepRecentTokens?: number;
    };
  }) => void;
  setCompactionEnabled?: (enabled: boolean) => void;
};

export function ensurePiCompactionReserveTokens(params: {
  settingsManager: PiSettingsManagerLike;
  minReserveTokens?: number;
}): { didOverride: boolean; reserveTokens: number } {
  const minReserveTokens = params.minReserveTokens ?? DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
  const current = params.settingsManager.getCompactionReserveTokens();

  if (current >= minReserveTokens) {
    return { didOverride: false, reserveTokens: current };
  }

  params.settingsManager.applyOverrides({
    compaction: { reserveTokens: minReserveTokens },
  });

  return { didOverride: true, reserveTokens: minReserveTokens };
}

export function resolveCompactionReserveTokensFloor(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.compaction?.reserveTokensFloor;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;
}

function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function estimateCharsAsTokens(chars: unknown): number {
  if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) {
    return 0;
  }
  return Math.ceil(chars / 4);
}

function estimateTokensFromChars(chars: unknown): number {
  if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) {
    return 0;
  }
  return Math.ceil(Math.floor(chars) / 4);
}

export function applyPiCompactionSettingsFromConfig(params: {
  settingsManager: PiSettingsManagerLike;
  cfg?: OpenClawConfig;
}): {
  didOverride: boolean;
  compaction: { reserveTokens: number; keepRecentTokens: number };
} {
  const currentReserveTokens = params.settingsManager.getCompactionReserveTokens();
  const currentKeepRecentTokens = params.settingsManager.getCompactionKeepRecentTokens();
  const compactionCfg = params.cfg?.agents?.defaults?.compaction;

  const configuredReserveTokens = toNonNegativeInt(compactionCfg?.reserveTokens);
  const configuredKeepRecentTokens = toPositiveInt(compactionCfg?.keepRecentTokens);
  const reserveTokensFloor = resolveCompactionReserveTokensFloor(params.cfg);

  const targetReserveTokens = Math.max(
    configuredReserveTokens ?? currentReserveTokens,
    reserveTokensFloor,
  );
  const targetKeepRecentTokens = configuredKeepRecentTokens ?? currentKeepRecentTokens;

  const overrides: { reserveTokens?: number; keepRecentTokens?: number } = {};
  if (targetReserveTokens !== currentReserveTokens) {
    overrides.reserveTokens = targetReserveTokens;
  }
  if (targetKeepRecentTokens !== currentKeepRecentTokens) {
    overrides.keepRecentTokens = targetKeepRecentTokens;
  }

  const didOverride = Object.keys(overrides).length > 0;
  if (didOverride) {
    params.settingsManager.applyOverrides({ compaction: overrides });
  }

  return {
    didOverride,
    compaction: {
      reserveTokens: targetReserveTokens,
      keepRecentTokens: targetKeepRecentTokens,
    },
  };
}

export function applyPiAdaptiveKeepRecentBudget(params: {
  settingsManager: PiSettingsManagerLike;
  contextWindowTokens?: number;
  systemPromptChars?: number;
  promptChars?: number;
  promptImageCount?: number;
  safetyMarginTokens?: number;
  minKeepRecentTokens?: number;
}): {
  didOverride: boolean;
  keepRecentTokens: number;
  keepRecentTokensCap: number;
  reserveTokens: number;
  estimatedSystemPromptTokens: number;
  estimatedPromptTokens: number;
  estimatedPromptImageTokens: number;
  safetyMarginTokens: number;
  availableHistoryTokens: number;
} {
  const currentKeepRecentTokens = params.settingsManager.getCompactionKeepRecentTokens();
  const reserveTokens = params.settingsManager.getCompactionReserveTokens();
  const contextWindowTokens =
    typeof params.contextWindowTokens === "number" &&
    Number.isFinite(params.contextWindowTokens) &&
    params.contextWindowTokens > 0
      ? Math.floor(params.contextWindowTokens)
      : 0;
  const estimatedSystemPromptTokens = estimateTokensFromChars(params.systemPromptChars);
  const estimatedPromptTokens = estimateTokensFromChars(params.promptChars);
  const estimatedPromptImageTokens =
    Math.max(0, Math.floor(params.promptImageCount ?? 0)) * DEFAULT_PI_PROMPT_IMAGE_TOKEN_ESTIMATE;
  const safetyMarginTokens = Math.max(
    0,
    Math.floor(params.safetyMarginTokens ?? DEFAULT_PI_COMPACTION_DYNAMIC_KEEP_MARGIN_TOKENS),
  );
  const minKeepRecentTokens = Math.max(
    1,
    Math.floor(params.minKeepRecentTokens ?? MIN_PI_DYNAMIC_KEEP_RECENT_TOKENS),
  );

  if (contextWindowTokens <= 0 || estimatedSystemPromptTokens <= 0) {
    return {
      didOverride: false,
      keepRecentTokens: currentKeepRecentTokens,
      keepRecentTokensCap: currentKeepRecentTokens,
      reserveTokens,
      estimatedSystemPromptTokens,
      estimatedPromptTokens,
      estimatedPromptImageTokens,
      safetyMarginTokens,
      availableHistoryTokens: 0,
    };
  }

  const availableHistoryTokens = Math.max(
    0,
    contextWindowTokens -
      reserveTokens -
      estimatedSystemPromptTokens -
      estimatedPromptTokens -
      estimatedPromptImageTokens -
      safetyMarginTokens,
  );
  const keepRecentTokensCap = Math.max(minKeepRecentTokens, availableHistoryTokens);

  if (keepRecentTokensCap >= currentKeepRecentTokens) {
    return {
      didOverride: false,
      keepRecentTokens: currentKeepRecentTokens,
      keepRecentTokensCap,
      reserveTokens,
      estimatedSystemPromptTokens,
      estimatedPromptTokens,
      estimatedPromptImageTokens,
      safetyMarginTokens,
      availableHistoryTokens,
    };
  }

  params.settingsManager.applyOverrides({
    compaction: { keepRecentTokens: keepRecentTokensCap },
  });

  return {
    didOverride: true,
    keepRecentTokens: keepRecentTokensCap,
    keepRecentTokensCap,
    reserveTokens,
    estimatedSystemPromptTokens,
    estimatedPromptTokens,
    estimatedPromptImageTokens,
    safetyMarginTokens,
    availableHistoryTokens,
  };
}

export function resolveOverflowCompactionKeepRecentTokens(params: {
  contextWindowTokens?: number;
  currentKeepRecentTokens: number;
  reserveTokens: number;
  systemPromptChars?: number;
  promptChars?: number;
  promptImageCount?: number;
}): number | undefined {
  const contextWindowTokens = toPositiveInt(params.contextWindowTokens);
  const currentKeepRecentTokens = toPositiveInt(params.currentKeepRecentTokens);
  if (!contextWindowTokens || !currentKeepRecentTokens) {
    return undefined;
  }

  const reserveTokens = Math.max(0, toNonNegativeInt(params.reserveTokens) ?? 0);
  const systemPromptTokens = estimateCharsAsTokens(params.systemPromptChars);
  const promptTokens = estimateCharsAsTokens(params.promptChars);
  const promptImageTokens =
    Math.max(0, Math.floor(params.promptImageCount ?? 0)) * DEFAULT_PI_PROMPT_IMAGE_TOKEN_ESTIMATE;
  const safetyMarginTokens = Math.max(4_000, Math.floor(contextWindowTokens * 0.05));
  const availableHistoryTokens = Math.max(
    0,
    contextWindowTokens -
      reserveTokens -
      systemPromptTokens -
      promptTokens -
      promptImageTokens -
      safetyMarginTokens,
  );

  // Overflow recovery should keep materially less history than a normal turn so
  // compaction can actually cut into the retained branch.
  const capByContextShare = Math.max(8_000, Math.floor(contextWindowTokens * 0.2));
  const capByAvailableHistory =
    availableHistoryTokens > 0
      ? Math.min(
          availableHistoryTokens,
          Math.max(MIN_PI_DYNAMIC_KEEP_RECENT_TOKENS, Math.floor(availableHistoryTokens * 0.5)),
        )
      : 8_000;
  const nextKeepRecentTokens = Math.min(
    currentKeepRecentTokens,
    capByContextShare,
    capByAvailableHistory,
  );

  return nextKeepRecentTokens < currentKeepRecentTokens ? nextKeepRecentTokens : undefined;
}

/** Decide whether Pi's internal auto-compaction should be disabled for this run. */
export function shouldDisablePiAutoCompaction(params: {
  contextEngineInfo?: ContextEngineInfo;
}): boolean {
  return params.contextEngineInfo?.ownsCompaction === true;
}

/** Disable Pi auto-compaction via settings when a context engine owns compaction. */
export function applyPiAutoCompactionGuard(params: {
  settingsManager: PiSettingsManagerLike;
  contextEngineInfo?: ContextEngineInfo;
}): { supported: boolean; disabled: boolean } {
  const disable = shouldDisablePiAutoCompaction({
    contextEngineInfo: params.contextEngineInfo,
  });
  const hasMethod = typeof params.settingsManager.setCompactionEnabled === "function";
  if (!disable || !hasMethod) {
    return { supported: hasMethod, disabled: false };
  }
  params.settingsManager.setCompactionEnabled!(false);
  return { supported: true, disabled: true };
}
