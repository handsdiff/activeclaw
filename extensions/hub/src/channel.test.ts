import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  deleteAccountFromConfigSectionMock,
  listHubAccountIdsMock,
  resolveDefaultHubAccountIdMock,
  resolveHubAccountMock,
  sendMessageHubMock,
  setAccountEnabledInConfigSectionMock,
} = vi.hoisted(() => ({
  deleteAccountFromConfigSectionMock: vi.fn(() => ({})),
  listHubAccountIdsMock: vi.fn(() => ["default"]),
  resolveDefaultHubAccountIdMock: vi.fn(() => "default"),
  resolveHubAccountMock: vi.fn(),
  sendMessageHubMock: vi.fn(),
  setAccountEnabledInConfigSectionMock: vi.fn(() => ({})),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  buildBaseAccountStatusSnapshot: vi.fn(() => ({})),
  buildBaseChannelStatusSummary: vi.fn(() => ({})),
  buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
  DEFAULT_ACCOUNT_ID: "default",
  deleteAccountFromConfigSection: deleteAccountFromConfigSectionMock,
  formatPairingApproveHint: vi.fn(() => "approve via hub"),
  PAIRING_APPROVED_MESSAGE: "approved",
  setAccountEnabledInConfigSection: setAccountEnabledInConfigSectionMock,
}));

vi.mock("./accounts.js", () => ({
  listHubAccountIds: listHubAccountIdsMock,
  resolveDefaultHubAccountId: resolveDefaultHubAccountIdMock,
  resolveHubAccount: resolveHubAccountMock,
}));

vi.mock("./config-schema.js", () => ({
  HubConfigSchema: { type: "object" },
}));

vi.mock("./monitor.js", () => ({
  monitorHubProvider: vi.fn(),
}));

vi.mock("./onboarding.js", () => ({
  hubOnboardingAdapter: {},
}));

vi.mock("./probe.js", () => ({
  probeHub: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getHubRuntime: vi.fn(() => ({
    channel: {
      activity: {
        record: vi.fn(),
      },
      text: {
        chunkMarkdownText: vi.fn(),
      },
    },
  })),
}));

vi.mock("./send.js", () => ({
  sendMessageHub: sendMessageHubMock,
}));

const { hubPlugin } = await import("./channel.js");

describe("hubPlugin normalization", () => {
  beforeEach(() => {
    sendMessageHubMock.mockReset();
    sendMessageHubMock.mockResolvedValue({
      messageId: "hub-1",
      target: "brain",
    });
    resolveHubAccountMock.mockReset();
    resolveHubAccountMock.mockReturnValue({
      accountId: "default",
      name: "Hub",
      enabled: true,
      configured: true,
      url: "https://hub.example.test",
      agentId: "sender",
      secretSource: "inline",
      config: {
        allowFrom: [" hub:Brain ", "*", "CombinatorAgent ", "hub:"],
        defaultTo: " hub:TargetAgent ",
        dmPolicy: "open",
      },
    });
  });

  it("normalizes outbound hub targets", () => {
    expect(hubPlugin.messaging?.normalizeTarget?.("  hub:Brain  ")).toBe("Brain");
    expect(hubPlugin.messaging?.normalizeTarget?.("CombinatorAgent")).toBe("CombinatorAgent");
    expect(hubPlugin.messaging?.normalizeTarget?.("hub:")).toBeUndefined();
  });

  it("normalizes pairing allow entries and approval targets", async () => {
    expect(hubPlugin.pairing?.normalizeAllowEntry?.(" hub:Brain ")).toBe("brain");
    expect(hubPlugin.pairing?.normalizeAllowEntry?.("hub:*")).toBe("*");

    await hubPlugin.pairing?.notifyApproval?.({ id: " hub:Brain " } as any);

    expect(sendMessageHubMock).toHaveBeenCalledWith("Brain", "approved");
  });

  it("normalizes config-derived allowFrom and defaultTo values", () => {
    const cfg = { channels: { hub: {} } };

    expect(hubPlugin.config.resolveAllowFrom({ cfg, accountId: "default" } as any)).toEqual([
      "brain",
      "*",
      "combinatoragent",
    ]);
    expect(
      hubPlugin.config.formatAllowFrom({
        allowFrom: [" hub:Brain ", "COMBINATORAGENT", "*", "hub:"],
      } as any),
    ).toEqual(["brain", "combinatoragent", "*"]);
    expect(hubPlugin.config.resolveDefaultTo({ cfg, accountId: "default" } as any)).toBe(
      "TargetAgent",
    );
  });

  it("normalizes dm-policy entries, resolver ids, and directory peers", async () => {
    const cfg = { channels: { hub: {} } };
    const account = resolveHubAccountMock.mock.results[0]?.value ?? resolveHubAccountMock();
    const dmPolicy = hubPlugin.security.resolveDmPolicy({
      cfg,
      accountId: "default",
      account,
    } as any);

    expect(dmPolicy.normalizeEntry(" hub:Brain ")).toBe("brain");
    expect(dmPolicy.normalizeEntry("hub:*")).toBe("*");

    await expect(
      hubPlugin.resolver.resolveTargets({
        inputs: [" hub:Brain ", " hub: ", "CombinatorAgent"],
      } as any),
    ).resolves.toEqual([
      { input: " hub:Brain ", resolved: true, id: "Brain", name: "Brain" },
      { input: " hub: ", resolved: false, note: "empty target" },
      {
        input: "CombinatorAgent",
        resolved: true,
        id: "CombinatorAgent",
        name: "CombinatorAgent",
      },
    ]);

    await expect(
      hubPlugin.directory.listPeers({
        cfg,
        accountId: "default",
        limit: 10,
      } as any),
    ).resolves.toEqual([
      { kind: "user", id: "brain" },
      { kind: "user", id: "combinatoragent" },
    ]);
  });
});
