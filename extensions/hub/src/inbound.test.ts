import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("replies to the plain Hub id while keeping prefixed conversation history keys", async () => {
    const sendReplyMock = vi.fn().mockResolvedValue(undefined);

    await handleHubInbound({
      message: {
        messageId: "msg-1",
        from: "CombinatorAgent",
        text: "hello",
        timestamp: 123,
      },
      account: {
        accountId: "default",
        config: {
          dmPolicy: "open",
          allowFrom: ["*"],
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
      sendReply: sendReplyMock,
    });

    expect(sendReplyMock).toHaveBeenCalledWith("CombinatorAgent", "reply body");
    expect(sendMessageHubMock).not.toHaveBeenCalled();
    expect(emitOutboundHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "hub:CombinatorAgent",
      }),
    );
  });
});
