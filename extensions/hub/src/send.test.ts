import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  convertMarkdownTablesMock,
  fetchWithSsrFGuardMock,
  getHubRuntimeMock,
  loadConfigMock,
  recordActivityMock,
  resolveHubAccountMock,
  resolveMarkdownTableModeMock,
  releaseMock,
} = vi.hoisted(() => ({
  convertMarkdownTablesMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  getHubRuntimeMock: vi.fn(),
  loadConfigMock: vi.fn(),
  recordActivityMock: vi.fn(),
  resolveHubAccountMock: vi.fn(),
  resolveMarkdownTableModeMock: vi.fn(),
  releaseMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("./accounts.js", () => ({
  resolveHubAccount: resolveHubAccountMock,
}));

vi.mock("./runtime.js", () => ({
  getHubRuntime: getHubRuntimeMock,
}));

import { sendMessageHub } from "./send.js";

describe("sendMessageHub", () => {
  beforeEach(() => {
    convertMarkdownTablesMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
    getHubRuntimeMock.mockReset();
    loadConfigMock.mockReset();
    recordActivityMock.mockReset();
    releaseMock.mockReset();
    resolveHubAccountMock.mockReset();
    resolveMarkdownTableModeMock.mockReset();

    releaseMock.mockResolvedValue(undefined);
    loadConfigMock.mockReturnValue({});
    resolveMarkdownTableModeMock.mockReturnValue("off");
    convertMarkdownTablesMock.mockImplementation((text: string) => text);
    recordActivityMock.mockReturnValue(undefined);
    resolveHubAccountMock.mockReturnValue({
      configured: true,
      accountId: "default",
      url: "https://hub.example.test",
      agentId: "sender",
      secret: "shared-secret",
    });
    getHubRuntimeMock.mockReturnValue({
      config: { loadConfig: loadConfigMock },
      channel: {
        text: {
          resolveMarkdownTableMode: resolveMarkdownTableModeMock,
          convertMarkdownTables: convertMarkdownTablesMock,
        },
        activity: {
          record: recordActivityMock,
        },
      },
    });
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: {
        ok: true,
      },
      release: releaseMock,
    });
  });

  it("posts to the plain agent id when given a hub:-prefixed recipient", async () => {
    const result = await sendMessageHub("  hub:Brain  ", "hello");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://hub.example.test/agents/Brain/message",
      }),
    );
    expect(result.target).toBe("Brain");
  });

  it("rejects empty recipients after normalization", async () => {
    await expect(sendMessageHub("hub:", "hello")).rejects.toThrow(
      "Hub send target must be non-empty",
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});
