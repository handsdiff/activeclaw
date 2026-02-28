import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  fetchWithSsrFGuard,
  formatDocsLink,
  promptAccountId,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type DmPolicy,
  type WizardPrompter,
} from "openclaw/plugin-sdk";
import { listHubAccountIds, resolveDefaultHubAccountId, resolveHubAccount } from "./accounts.js";
import type { CoreConfig, HubAccountConfig } from "./types.js";

const channel = "hub" as const;

function updateHubAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  patch: Partial<HubAccountConfig>,
): CoreConfig {
  const current = cfg.channels?.hub ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        hub: {
          ...current,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      hub: {
        ...current,
        accounts: {
          ...current.accounts,
          [accountId]: {
            ...current.accounts?.[accountId],
            ...patch,
          },
        },
      },
    },
  };
}

function setHubDmPolicy(cfg: CoreConfig, dmPolicy: DmPolicy): CoreConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.hub?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      hub: {
        ...cfg.channels?.hub,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setHubAllowFrom(cfg: CoreConfig, allowFrom: string[]): CoreConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      hub: {
        ...cfg.channels?.hub,
        allowFrom,
      },
    },
  };
}

type HubRegisterResponse = {
  secret: string;
  wallet_address?: string;
  hub_balance?: number;
};

async function registerHubAgent(url: string, agentId: string): Promise<HubRegisterResponse> {
  const registerUrl = `${url.replace(/\/+$/, "")}/agents/register`;
  const { response, release } = await fetchWithSsrFGuard({
    url: registerUrl,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId }),
    },
    timeoutMs: 15_000,
  });

  try {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Registration failed (${response.status}): ${body}`);
    }
    return (await response.json()) as HubRegisterResponse;
  } finally {
    await release();
  }
}

function parseListInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptHubAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<CoreConfig> {
  const existing = params.cfg.channels?.hub?.allowFrom ?? [];

  await params.prompter.note(
    [
      "Allowlist Hub DMs by sender agent ID.",
      "Examples:",
      "- my-agent",
      "- prometheus-bne",
      "Multiple entries: comma-separated.",
    ].join("\n"),
    "Hub allowlist",
  );

  const raw = await params.prompter.text({
    message: "Hub allowFrom (agent IDs)",
    placeholder: "my-agent, other-agent",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });

  const parsed = parseListInput(String(raw));
  const normalized = [
    ...new Set(parsed.map((entry) => entry.trim().toLowerCase()).filter(Boolean)),
  ];
  return setHubAllowFrom(params.cfg, normalized);
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Hub",
  channel,
  policyKey: "channels.hub.dmPolicy",
  allowFromKey: "channels.hub.allowFrom",
  getCurrent: (cfg) => (cfg as CoreConfig).channels?.hub?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setHubDmPolicy(cfg as CoreConfig, policy),
  promptAllowFrom: promptHubAllowFrom,
};

export const hubOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const coreCfg = cfg as CoreConfig;
    const configured = listHubAccountIds(coreCfg).some(
      (accountId) => resolveHubAccount({ cfg: coreCfg, accountId }).configured,
    );
    return {
      channel,
      configured,
      statusLines: [`Hub: ${configured ? "configured" : "needs url + agentId + secret"}`],
      selectionHint: configured ? "configured" : "needs url + agentId + secret",
      quickstartScore: configured ? 1 : 0,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    let next = cfg as CoreConfig;
    const hubOverride = accountOverrides.hub?.trim();
    const defaultAccountId = resolveDefaultHubAccountId(next);
    let accountId = hubOverride || defaultAccountId;
    if (shouldPromptAccountIds && !hubOverride) {
      accountId = await promptAccountId({
        cfg: next,
        prompter,
        label: "Hub",
        currentId: accountId,
        listAccountIds: listHubAccountIds,
        defaultAccountId,
      });
    }

    const resolved = resolveHubAccount({ cfg: next, accountId });
    const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;
    const envUrl = isDefaultAccount ? process.env.HUB_URL?.trim() : "";
    const envAgentId = isDefaultAccount ? process.env.HUB_AGENT_ID?.trim() : "";
    const envSecret = isDefaultAccount ? process.env.HUB_SECRET?.trim() : "";
    const envReady = Boolean(envUrl && envAgentId && envSecret);

    if (!resolved.configured) {
      await noteHubSetupHelp(prompter);
    }

    let useEnv = false;
    if (
      envReady &&
      isDefaultAccount &&
      !resolved.config.url &&
      !resolved.config.agentId &&
      !resolved.config.secret
    ) {
      useEnv = await prompter.confirm({
        message: "HUB_URL, HUB_AGENT_ID, and HUB_SECRET detected. Use env vars?",
        initialValue: true,
      });
    }

    if (useEnv) {
      next = updateHubAccountConfig(next, accountId, { enabled: true });
    } else {
      const url = String(
        await prompter.text({
          message: "Hub server URL",
          initialValue: resolved.config.url || envUrl || undefined,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();

      const wantsRegister = await prompter.confirm({
        message: "Register a new agent on this Hub?",
        initialValue: !resolved.configured,
      });

      if (wantsRegister) {
        const desiredAgentId = String(
          await prompter.text({
            message: "Desired agent ID",
            initialValue: resolved.config.agentId || envAgentId || undefined,
            validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
          }),
        ).trim();

        try {
          const result = await registerHubAgent(url, desiredAgentId);
          await prompter.note(
            [
              `Agent "${desiredAgentId}" registered successfully.`,
              result.wallet_address ? `Wallet: ${result.wallet_address}` : "",
              result.hub_balance != null ? `Hub balance: ${result.hub_balance}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            "Registration complete",
          );
          next = updateHubAccountConfig(next, accountId, {
            enabled: true,
            url,
            agentId: desiredAgentId,
            secret: result.secret,
          });
        } catch (err) {
          await prompter.note(
            `Registration failed: ${err instanceof Error ? err.message : String(err)}\nYou can enter credentials manually instead.`,
            "Registration error",
          );
          // Fall through to manual entry.
          const agentId = String(
            await prompter.text({
              message: "Hub agent ID",
              initialValue: desiredAgentId,
              validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
            }),
          ).trim();
          const secret = String(
            await prompter.text({
              message: "Hub secret",
              validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
            }),
          ).trim();
          next = updateHubAccountConfig(next, accountId, {
            enabled: true,
            url,
            agentId,
            secret,
          });
        }
      } else {
        const agentId = String(
          await prompter.text({
            message: "Hub agent ID",
            initialValue: resolved.config.agentId || envAgentId || undefined,
            validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
          }),
        ).trim();

        const secret = String(
          await prompter.text({
            message: "Hub secret",
            initialValue: resolved.config.secret || envSecret || undefined,
            validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
          }),
        ).trim();

        next = updateHubAccountConfig(next, accountId, {
          enabled: true,
          url,
          agentId,
          secret,
        });
      }
    }

    if (forceAllowFrom) {
      next = await promptHubAllowFrom({ cfg: next, prompter, accountId });
    }

    await prompter.note(
      [
        "Next: restart gateway and verify status.",
        "Command: openclaw channels status --probe",
        `Docs: ${formatDocsLink("/channels/hub", "channels/hub")}`,
      ].join("\n"),
      "Hub next steps",
    );

    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...(cfg as CoreConfig),
    channels: {
      ...(cfg as CoreConfig).channels,
      hub: {
        ...(cfg as CoreConfig).channels?.hub,
        enabled: false,
      },
    },
  }),
};

async function noteHubSetupHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Hub needs a server URL, agent ID, and secret.",
      "These identify your agent on the Hub server.",
      "Env vars supported: HUB_URL, HUB_AGENT_ID, HUB_SECRET.",
      `Docs: ${formatDocsLink("/channels/hub", "channels/hub")}`,
    ].join("\n"),
    "Hub setup",
  );
}
