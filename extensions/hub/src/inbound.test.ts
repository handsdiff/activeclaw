import { beforeEach, describe, expect, it, vi } from "vitest";

type SendReply = (target: string, text: string) => Promise<void>;
type SendReplyMock = ReturnType<typeof vi.fn> & SendReply;

function createSendReplyMock(): SendReplyMock {
  return vi.fn(async () => undefined) as SendReplyMock;
}

const {
  createNormalizedOutboundDelivererMock,
  createReplyPrefixOptionsMock,
  createScopedPairingAccessMock,
  dispatchReplyWithBufferedBlockDispatcherMock,
  emitInboundHistoryMock,
  emitOutboundHistoryMock,
  formatTextWithAttachmentLinksMock,
  getHubRuntimeMock,
  logInboundDropMock,
  readStoreAllowFromForDmPolicyMock,
  recordInboundSessionMock,
  resolveControlCommandGateMock,
  resolveEffectiveAllowFromListsMock,
  resolveOutboundMediaUrlsMock,
  sendMessageHubMock,
} = vi.hoisted(() => ({
  createNormalizedOutboundDelivererMock: vi.fn(),
  createReplyPrefixOptionsMock: vi.fn(),
  createScopedPairingAccessMock: vi.fn(),
  dispatchReplyWithBufferedBlockDispatcherMock: vi.fn(),
  emitInboundHistoryMock: vi.fn(),
  emitOutboundHistoryMock: vi.fn(),
  formatTextWithAttachmentLinksMock: vi.fn(),
  getHubRuntimeMock: vi.fn(),
  logInboundDropMock: vi.fn(),
  readStoreAllowFromForDmPolicyMock: vi.fn(),
  recordInboundSessionMock: vi.fn(),
  resolveControlCommandGateMock: vi.fn(),
  resolveEffectiveAllowFromListsMock: vi.fn(),
  resolveOutboundMediaUrlsMock: vi.fn(),
  sendMessageHubMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  createScopedPairingAccess: createScopedPairingAccessMock,
  createNormalizedOutboundDeliverer: createNormalizedOutboundDelivererMock,
  createReplyPrefixOptions: createReplyPrefixOptionsMock,
  emitInboundHistory: emitInboundHistoryMock,
  emitOutboundHistory: emitOutboundHistoryMock,
  formatTextWithAttachmentLinks: formatTextWithAttachmentLinksMock,
  logInboundDrop: logInboundDropMock,
  readStoreAllowFromForDmPolicy: readStoreAllowFromForDmPolicyMock,
  resolveControlCommandGate: resolveControlCommandGateMock,
  resolveOutboundMediaUrls: resolveOutboundMediaUrlsMock,
  resolveEffectiveAllowFromLists: resolveEffectiveAllowFromListsMock,
}));

vi.mock("./runtime.js", () => ({
  getHubRuntime: getHubRuntimeMock,
}));

vi.mock("./send.js", () => ({
  sendMessageHub: sendMessageHubMock,
}));

import { handleHubInbound } from "./inbound.js";

describe("handleHubInbound", () => {
  beforeEach(() => {
    createScopedPairingAccessMock.mockReset();
    createNormalizedOutboundDelivererMock.mockReset();
    createReplyPrefixOptionsMock.mockReset();
    dispatchReplyWithBufferedBlockDispatcherMock.mockReset();
    emitInboundHistoryMock.mockReset();
    emitOutboundHistoryMock.mockReset();
    formatTextWithAttachmentLinksMock.mockReset();
    getHubRuntimeMock.mockReset();
    logInboundDropMock.mockReset();
    readStoreAllowFromForDmPolicyMock.mockReset();
    recordInboundSessionMock.mockReset();
    resolveControlCommandGateMock.mockReset();
    resolveEffectiveAllowFromListsMock.mockReset();
    resolveOutboundMediaUrlsMock.mockReset();
    sendMessageHubMock.mockReset();

    createScopedPairingAccessMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(),
      upsertPairingRequest: vi.fn(),
    });
    createNormalizedOutboundDelivererMock.mockImplementation((deliver: unknown) => deliver);
    createReplyPrefixOptionsMock.mockReturnValue({
      onModelSelected: vi.fn(),
      includePrefix: false,
    });
    readStoreAllowFromForDmPolicyMock.mockResolvedValue([]);
    resolveEffectiveAllowFromListsMock.mockReturnValue({
      effectiveAllowFrom: ["*"],
    });
    resolveControlCommandGateMock.mockReturnValue({
      commandAuthorized: true,
      shouldBlock: false,
    });
    resolveOutboundMediaUrlsMock.mockReturnValue([]);
    formatTextWithAttachmentLinksMock.mockImplementation((text: string) => text);
    recordInboundSessionMock.mockResolvedValue(undefined);
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async (params: Record<string, any>) => {
        await params.dispatcherOptions.deliver({ text: "reply body" });
      },
    );
    getHubRuntimeMock.mockReturnValue({
      channel: {
        commands: {
          shouldHandleTextCommands: vi.fn(() => true),
        },
        pairing: {
          buildPairingReply: vi.fn(() => "pairing reply"),
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
          finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ctx),
          formatAgentEnvelope: vi.fn(() => "formatted inbound"),
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "main",
            sessionKey: "agent:main:hub:direct:CombinatorAgent",
            accountId: "default",
          })),
        },
        session: {
          readSessionUpdatedAt: vi.fn(() => undefined),
          recordInboundSession: recordInboundSessionMock,
          resolveStorePath: vi.fn(() => "/tmp/openclaw-store"),
        },
        text: {
          hasControlCommand: vi.fn(() => false),
        },
      },
    });
  });

  function buildParams(overrides?: {
    message?: Record<string, unknown>;
    accountConfig?: Record<string, unknown>;
    sendReply?: SendReply;
  }) {
    return {
      message: {
        messageId: "msg-1",
        from: "CombinatorAgent",
        text: "hello",
        timestamp: 123,
        ...overrides?.message,
      },
      account: {
        accountId: "default",
        config: {
          dmPolicy: "open",
          allowFrom: ["*"],
          ...overrides?.accountConfig,
        },
      } as any,
      config: {
        commands: {},
        session: {
          store: {},
        },
      } as any,
      runtime: {
        error: vi.fn(),
        log: vi.fn(),
      } as any,
      sendReply: overrides?.sendReply ?? createSendReplyMock(),
    };
  }

  it("replies to the plain Hub id while keeping prefixed conversation history keys", async () => {
    const sendReplyMock = createSendReplyMock();

    await handleHubInbound(buildParams({ sendReply: sendReplyMock }));

    expect(sendReplyMock).toHaveBeenCalledWith("CombinatorAgent", "reply body");
    expect(sendMessageHubMock).not.toHaveBeenCalled();
    expect(emitOutboundHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "hub:CombinatorAgent",
      }),
    );
  });

  it("accepts prefixed config allowFrom entries under allowlist policy", async () => {
    const sendReplyMock = createSendReplyMock();
    resolveEffectiveAllowFromListsMock.mockImplementation(({ allowFrom, storeAllowFrom }) => ({
      effectiveAllowFrom: [...allowFrom, ...storeAllowFrom],
    }));

    await handleHubInbound(
      buildParams({
        sendReply: sendReplyMock,
        accountConfig: {
          dmPolicy: "allowlist",
          allowFrom: ["hub:CombinatorAgent"],
        },
      }),
    );

    expect(sendReplyMock).toHaveBeenCalledWith("CombinatorAgent", "reply body");
    expect(resolveEffectiveAllowFromListsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFrom: ["combinatoragent"],
      }),
    );
  });

  it("accepts prefixed store allowFrom entries under allowlist policy", async () => {
    const sendReplyMock = createSendReplyMock();
    readStoreAllowFromForDmPolicyMock.mockResolvedValue(["hub:CombinatorAgent"]);
    resolveEffectiveAllowFromListsMock.mockImplementation(({ allowFrom, storeAllowFrom }) => ({
      effectiveAllowFrom: [...allowFrom, ...storeAllowFrom],
    }));

    await handleHubInbound(
      buildParams({
        sendReply: sendReplyMock,
        accountConfig: {
          dmPolicy: "allowlist",
          allowFrom: [],
        },
      }),
    );

    expect(sendReplyMock).toHaveBeenCalledWith("CombinatorAgent", "reply body");
    expect(resolveEffectiveAllowFromListsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storeAllowFrom: ["combinatoragent"],
      }),
    );
  });

  it("preserves sender casing when creating Hub pairing requests", async () => {
    const upsertPairingRequestMock = vi.fn().mockResolvedValue({
      code: "PAIR1234",
      created: true,
    });
    const sendReplyMock = createSendReplyMock();
    createScopedPairingAccessMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(),
      upsertPairingRequest: upsertPairingRequestMock,
    });
    resolveEffectiveAllowFromListsMock.mockImplementation(({ allowFrom, storeAllowFrom }) => ({
      effectiveAllowFrom: [...allowFrom, ...storeAllowFrom],
    }));

    await handleHubInbound(
      buildParams({
        sendReply: sendReplyMock,
        accountConfig: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      }),
    );

    expect(upsertPairingRequestMock).toHaveBeenCalledWith({
      id: "CombinatorAgent",
      meta: { name: "CombinatorAgent" },
    });
    expect(sendReplyMock).toHaveBeenCalledWith("CombinatorAgent", "pairing reply");
    expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
  });
});
