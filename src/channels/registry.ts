import { requireActivePluginRegistry } from "../plugins/runtime.js";
import type { ChannelId, ChannelMeta } from "./plugins/types.js";
import { isSupportedChannelId } from "./supported.js";

export const CHAT_CHANNEL_ORDER = ["telegram"] as const;

export type ChatChannelId = (typeof CHAT_CHANNEL_ORDER)[number];

export const CHANNEL_IDS = [...CHAT_CHANNEL_ORDER] as const;

export type ChatChannelMeta = ChannelMeta;

const CHAT_CHANNEL_META: Record<ChatChannelId, ChannelMeta> = {
  telegram: {
    id: "telegram",
    label: "Telegram",
    selectionLabel: "Telegram (Bot API)",
    detailLabel: "Telegram Bot",
    docsPath: "/channels/telegram",
    docsLabel: "telegram",
    blurb: "Bot API messaging with group, channel, and topic support.",
    systemImage: "paperplane",
  },
};

export const CHAT_CHANNEL_ALIASES: Record<string, ChatChannelId> = {
  tg: "telegram",
};

function normalizeChannelKey(raw?: string | null): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  return normalized || undefined;
}

export function listChatChannels(): ChatChannelMeta[] {
  return CHAT_CHANNEL_ORDER.map((id) => CHAT_CHANNEL_META[id]);
}

export function listChatChannelAliases(): string[] {
  return Object.keys(CHAT_CHANNEL_ALIASES);
}

export function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta {
  return CHAT_CHANNEL_META[id];
}

export function normalizeChatChannelId(raw?: string | null): ChatChannelId | null {
  const normalized = normalizeChannelKey(raw);
  if (!normalized) {
    return null;
  }
  const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
  return CHAT_CHANNEL_ORDER.includes(resolved as ChatChannelId)
    ? (resolved as ChatChannelId)
    : null;
}

export function normalizeChannelId(raw?: string | null): ChatChannelId | null {
  return normalizeChatChannelId(raw);
}

export function normalizeAnyChannelId(raw?: string | null): ChannelId | null {
  const key = normalizeChannelKey(raw);
  if (!key) {
    return null;
  }

  const builtIn = normalizeChatChannelId(key);
  if (builtIn) {
    return builtIn;
  }

  const registry = requireActivePluginRegistry();
  const hit = registry.channels.find((entry) => {
    const id = String(entry.plugin.id ?? "")
      .trim()
      .toLowerCase();
    if (id && id === key && isSupportedChannelId(id)) {
      return true;
    }
    return (
      isSupportedChannelId(entry.plugin.id) &&
      (entry.plugin.meta.aliases ?? []).some((alias) => alias.trim().toLowerCase() === key)
    );
  });
  return hit?.plugin.id ?? null;
}

export function formatChannelPrimerLine(meta: ChatChannelMeta): string {
  return `${meta.label}: ${meta.blurb}`;
}

export function formatChannelSelectionLine(
  meta: ChatChannelMeta,
  docsLink: (path: string, label?: string) => string,
): string {
  return `${meta.label} - ${meta.blurb} Docs: ${docsLink(meta.docsPath, meta.docsLabel ?? meta.id)}`;
}
