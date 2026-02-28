import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig, HubAccountConfig } from "./types.js";

export type ResolvedHubAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  url: string;
  agentId: string;
  secret: string;
  secretSource: "env" | "secretFile" | "config" | "none";
  pollTimeoutSec: number;
  config: HubAccountConfig;
};

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.hub?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (key.trim()) {
      ids.add(normalizeAccountId(key));
    }
  }
  return [...ids];
}

function resolveAccountConfig(cfg: CoreConfig, accountId: string): HubAccountConfig | undefined {
  const accounts = cfg.channels?.hub?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as HubAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as HubAccountConfig | undefined) : undefined;
}

function mergeHubAccountConfig(cfg: CoreConfig, accountId: string): HubAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.hub ?? {}) as HubAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveSecret(
  accountId: string,
  merged: HubAccountConfig,
): { secret: string; source: "env" | "secretFile" | "config" | "none" } {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envSecret = process.env.HUB_SECRET?.trim();
    if (envSecret) {
      return { secret: envSecret, source: "env" };
    }
  }

  if (merged.secretFile?.trim()) {
    try {
      const fileSecret = readFileSync(merged.secretFile.trim(), "utf-8").trim();
      if (fileSecret) {
        return { secret: fileSecret, source: "secretFile" };
      }
    } catch {
      // Ignore unreadable files; status will surface missing configuration.
    }
  }

  const configSecret = merged.secret?.trim();
  if (configSecret) {
    return { secret: configSecret, source: "config" };
  }

  return { secret: "", source: "none" };
}

export function listHubAccountIds(cfg: CoreConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultHubAccountId(cfg: CoreConfig): string {
  const ids = listHubAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveHubAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedHubAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.hub?.enabled !== false;

  const resolve = (accountId: string): ResolvedHubAccount => {
    const merged = mergeHubAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;

    const url = (
      merged.url?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.HUB_URL?.trim() : "") ||
      ""
    ).replace(/\/+$/, "");

    const agentId = (
      merged.agentId?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.HUB_AGENT_ID?.trim() : "") ||
      ""
    ).trim();

    const secretResolution = resolveSecret(accountId, merged);
    const pollTimeoutSec = merged.pollTimeoutSec ?? 30;

    const config: HubAccountConfig = {
      ...merged,
      url: url || undefined,
      agentId: agentId || undefined,
      pollTimeoutSec,
    };

    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      configured: Boolean(url && agentId && secretResolution.secret),
      url,
      agentId,
      secret: secretResolution.secret,
      secretSource: secretResolution.source,
      pollTimeoutSec,
      config,
    };
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.configured) {
    return primary;
  }

  const fallbackId = resolveDefaultHubAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (!fallback.configured) {
    return primary;
  }
  return fallback;
}

export function listEnabledHubAccounts(cfg: CoreConfig): ResolvedHubAccount[] {
  return listHubAccountIds(cfg)
    .map((accountId) => resolveHubAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
