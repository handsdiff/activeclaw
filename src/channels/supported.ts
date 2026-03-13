const SUPPORTED_CHANNEL_IDS = ["telegram", "hub"] as const;

export { SUPPORTED_CHANNEL_IDS };

export type SupportedChannelId = (typeof SUPPORTED_CHANNEL_IDS)[number];

const SUPPORTED_CHANNEL_ID_SET = new Set<string>(SUPPORTED_CHANNEL_IDS);

export function isSupportedChannelId(raw?: string | null): raw is SupportedChannelId {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return SUPPORTED_CHANNEL_ID_SET.has(normalized);
}

export function filterSupportedChannelEntries<T extends { id: string }>(entries: T[]): T[] {
  return entries.filter((entry) => isSupportedChannelId(entry.id));
}
