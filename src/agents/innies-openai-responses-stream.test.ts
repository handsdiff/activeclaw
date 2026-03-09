import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  buildInniesResponsesParams,
  createInniesCompatibleFetch,
  INNIES_PROXY_USER_AGENT,
  isInniesOpenAIResponsesBaseUrl,
} from "./innies-openai-responses-stream.js";

function buildModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
  return {
    id: "gpt-5.4",
    name: "gpt-5.4",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.innies.computer/v1/proxy/v1",
    headers: {},
    input: ["text"],
    output: ["text"],
    maxTokens: 128000,
    contextWindow: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    ...overrides,
  } as unknown as Model<"openai-responses">;
}

describe("innies openai responses stream", () => {
  it("detects Innies proxy base URLs", () => {
    expect(isInniesOpenAIResponsesBaseUrl("https://api.innies.computer/v1/proxy/v1")).toBe(true);
    expect(isInniesOpenAIResponsesBaseUrl("https://example.test/v1/proxy/v1/")).toBe(true);
    expect(isInniesOpenAIResponsesBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isInniesOpenAIResponsesBaseUrl("not-a-url")).toBe(false);
  });

  it("replaces the OpenAI SDK user-agent before sending to Innies", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const fetchWithInniesHeaders = createInniesCompatibleFetch(fetchImpl as typeof fetch);

    await fetchWithInniesHeaders("https://example.test/v1/proxy/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer in_test",
        "user-agent": "OpenAI/JS 6.10.0",
      },
      body: JSON.stringify({ ok: true }),
    });

    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer in_test");
    expect(headers.get("user-agent")).toBe(INNIES_PROXY_USER_AGENT);
  });

  it("moves the system prompt into top-level instructions", () => {
    const model = buildModel();
    const context: Context = {
      systemPrompt: "Be concise.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      ],
    };

    const params = buildInniesResponsesParams(model, context, { sessionId: "sess_123" });

    expect(params.instructions).toBe("Be concise.");
    expect(Array.isArray(params.input)).toBe(true);
    expect((params.input as Array<{ role?: string }>).map((item) => item.role)).toEqual(["user"]);
    expect(params.prompt_cache_key).toBe("sess_123");
  });
});
