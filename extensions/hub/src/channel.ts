import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import {
  listHubAccountIds,
  resolveDefaultHubAccountId,
  resolveHubAccount,
  type ResolvedHubAccount,
} from "./accounts.js";
import { HubConfigSchema } from "./config-schema.js";
import { monitorHubProvider } from "./monitor.js";
import { hubOnboardingAdapter } from "./onboarding.js";
import { probeHub } from "./probe.js";
import { getHubRuntime } from "./runtime.js";
import { sendMessageHub } from "./send.js";
import type { CoreConfig, HubProbe } from "./types.js";

export const hubPlugin: ChannelPlugin<ResolvedHubAccount, HubProbe> = {
  id: "hub",
  meta: {
    id: "hub",
    label: "Hub",
    selectionLabel: "Hub (agent-to-agent)",
    docsPath: "/channels/hub",
    docsLabel: "hub",
    blurb: "Agent-to-agent messaging via Hub server",
    order: 100,
    quickstartAllowFrom: true,
  },
  onboarding: hubOnboardingAdapter,
  pairing: {
    idLabel: "hubAgent",
    normalizeAllowEntry: (entry) => String(entry).trim().toLowerCase(),
    notifyApproval: async ({ id }) => {
      const target = String(id).trim();
      if (!target) {
        throw new Error(`invalid Hub pairing id: ${id}`);
      }
      await sendMessageHub(target, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.hub"] },
  configSchema: buildChannelConfigSchema(HubConfigSchema),
  config: {
    listAccountIds: (cfg) => listHubAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveHubAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultHubAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "hub",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "hub",
        accountId,
        clearBaseFields: ["name", "url", "agentId", "secret", "secretFile"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      url: account.url,
      agentId: account.agentId,
      secretSource: account.secretSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveHubAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveHubAccount({ cfg: cfg as CoreConfig, accountId }).config.defaultTo?.trim() ||
      undefined,
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.hub?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.hub.accounts.${resolvedAccountId}.`
        : "channels.hub.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("hub"),
        normalizeEntry: (raw) => String(raw).trim().toLowerCase(),
      };
    },
  },
  messaging: {
    normalizeTarget: (input) => {
      const trimmed = String(input ?? "").trim();
      return trimmed || undefined;
    },
    targetResolver: {
      looksLikeId: (input) => Boolean(String(input ?? "").trim()),
      hint: "<agent-id>",
    },
  },
  resolver: {
    resolveTargets: async ({ inputs }) => {
      return inputs.map((input) => {
        const trimmed = String(input).trim();
        if (!trimmed) {
          return { input, resolved: false, note: "empty target" };
        }
        return { input, resolved: true, id: trimmed, name: trimmed };
      });
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveHubAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() ?? "";
      const ids = new Set<string>();
      for (const entry of account.config.allowFrom ?? []) {
        const normalized = String(entry).trim().toLowerCase();
        if (normalized && normalized !== "*") {
          ids.add(normalized);
        }
      }
      return Array.from(ids)
        .filter((id) => (q ? id.includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }));
    },
    listGroups: async () => [],
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getHubRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const result = await sendMessageHub(to, text, {
        accountId: accountId ?? undefined,
      });
      return { channel: "hub", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const combined = mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text;
      const result = await sendMessageHub(to, combined, {
        accountId: accountId ?? undefined,
      });
      return { channel: "hub", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ account, snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      url: account.url,
      agentId: account.agentId,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ cfg, account, timeoutMs }) =>
      probeHub(cfg as CoreConfig, { accountId: account.accountId, timeoutMs }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
      url: account.url,
      agentId: account.agentId,
      secretSource: account.secretSource,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        throw new Error(
          `Hub is not configured for account "${account.accountId}" (need url, agentId, and secret in channels.hub).`,
        );
      }
      ctx.log?.info(
        `[${account.accountId}] starting Hub provider (${account.url}, agent=${account.agentId})`,
      );
      const { stop } = await monitorHubProvider({
        accountId: account.accountId,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
      return { stop };
    },
  },
};
