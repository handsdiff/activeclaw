const HUB_PREFIX_RE = /^hub:/i;

export function normalizeHubTarget(raw: string | null | undefined): string | undefined {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(HUB_PREFIX_RE, "").trim();
  return normalized || undefined;
}

export function normalizeHubAllowEntry(raw: string | null | undefined): string | undefined {
  const normalized = normalizeHubTarget(raw);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "*") {
    return normalized;
  }
  return normalized.toLowerCase();
}
