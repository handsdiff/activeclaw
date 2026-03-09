import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "@mariozechner/pi-ai";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "@mariozechner/pi-ai/dist/providers/openai-responses-shared.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const INNIES_PROXY_PATH = "/v1/proxy/v1";
export const INNIES_PROXY_USER_AGENT = "OpenClaw/InniesProxy";

type InniesReasoningEffort = "minimal" | "low" | "medium" | "high";
type InniesServiceTier = "auto" | "default" | "flex" | "scale" | "priority";

type InniesStreamOptions = SimpleStreamOptions & {
  reasoningEffort?: InniesReasoningEffort;
  reasoningSummary?: string;
  serviceTier?: InniesServiceTier;
};

type InniesResponsesRequest = {
  model: string;
  input: unknown;
  stream: true;
  instructions?: string;
  prompt_cache_key?: string;
  prompt_cache_retention?: "in-memory" | "24h";
  store: false;
  max_output_tokens?: number;
  temperature?: number;
  service_tier?: InniesServiceTier;
  tools?: unknown;
  reasoning?: {
    effort: InniesReasoningEffort;
    summary: string;
  };
  include?: string[];
};

function normalizeProxyPath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function normalizeInstructions(systemPrompt: string | undefined): string | undefined {
  if (typeof systemPrompt !== "string") {
    return undefined;
  }
  return systemPrompt.trim().length > 0 ? systemPrompt : undefined;
}

function clampReasoning(
  effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh"> | undefined {
  return effort === "xhigh" ? "high" : effort;
}

function supportsXhigh(model: { id: string; api: string }): boolean {
  if (model.id.includes("gpt-5.2") || model.id.includes("gpt-5.3")) {
    return true;
  }
  if (model.api === "anthropic-messages") {
    return model.id.includes("opus-4-6") || model.id.includes("opus-4.6");
  }
  return false;
}

function resolveCacheRetention(
  cacheRetention: InniesStreamOptions["cacheRetention"],
): "none" | "short" | "long" {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

function getPromptCacheRetention(
  baseUrl: string | undefined,
  cacheRetention: ReturnType<typeof resolveCacheRetention>,
): InniesResponsesRequest["prompt_cache_retention"] | undefined {
  if (cacheRetention !== "long") {
    return undefined;
  }
  if (typeof baseUrl === "string" && baseUrl.includes("api.openai.com")) {
    return "24h";
  }
  return undefined;
}

function getServiceTierCostMultiplier(serviceTier: InniesServiceTier | null | undefined): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: AssistantMessage["usage"],
  serviceTier: InniesServiceTier | null | undefined,
): void {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1) {
    return;
  }
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function resolveResponsesUrl(baseUrl: string | undefined): string {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    throw new Error("OpenAI Responses baseUrl is required for Innies routing");
  }
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

async function buildErrorMessage(response: Response): Promise<string> {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const fallback = `Innies request failed (${status})`;
  const text = await response.text().catch(() => "");
  if (!text.trim()) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message =
      (typeof parsed.error?.message === "string" && parsed.error.message) ||
      (typeof parsed.message === "string" && parsed.message);
    return message ? `${fallback}: ${message}` : `${fallback}: ${text.trim()}`;
  } catch {
    return `${fallback}: ${text.trim()}`;
  }
}

async function* parseInniesSse(response: Response): AsyncGenerator<unknown, void, undefined> {
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (dataLines.length > 0) {
        const data = dataLines.join("\n").trim();
        if (data && data !== "[DONE]") {
          try {
            yield JSON.parse(data) as unknown;
          } catch {
            // Ignore malformed chunks and continue the stream.
          }
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
}

function buildInniesRequestHeaders(
  model: Model<"openai-responses">,
  options: InniesStreamOptions,
): Headers {
  const headers = new Headers(model.headers ?? {});
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      headers.set(key, value);
    }
  }
  headers.set("authorization", `Bearer ${resolveOpenAiApiKey(options)}`);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("user-agent", INNIES_PROXY_USER_AGENT);
  return headers;
}

export function isInniesOpenAIResponsesBaseUrl(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(baseUrl);
    return normalizeProxyPath(parsed.pathname).endsWith(INNIES_PROXY_PATH);
  } catch {
    return false;
  }
}

export function createInniesCompatibleFetch(
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      const initHeaders = new Headers(init.headers);
      for (const [key, value] of initHeaders.entries()) {
        headers.set(key, value);
      }
    }
    // Innies' edge currently blocks the OpenAI SDK User-Agent fingerprint.
    headers.set("user-agent", INNIES_PROXY_USER_AGENT);
    return fetchImpl(input, { ...init, headers });
  };
}

export function buildInniesResponsesParams(
  model: Model<"openai-responses">,
  context: Context,
  options?: InniesStreamOptions,
): InniesResponsesRequest {
  const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
  });
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const params: InniesResponsesRequest = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
    prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
    store: false,
  };

  const instructions = normalizeInstructions(context.systemPrompt);
  if (instructions) {
    params.instructions = instructions;
  }
  if (options?.maxTokens) {
    params.max_output_tokens = options.maxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.serviceTier !== undefined) {
    params.service_tier = options.serviceTier;
  }
  if (context.tools) {
    params.tools = convertResponsesTools(context.tools);
  }
  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoningSummary) {
      params.reasoning = {
        effort: options.reasoningEffort || "medium",
        summary: options.reasoningSummary || "auto",
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (model.name.startsWith("gpt-5")) {
      (messages as unknown as Array<Record<string, unknown>>).push({
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "# Juice: 0 !important",
          },
        ],
      });
    }
  }

  return params;
}

function resolveOpenAiApiKey(options: InniesStreamOptions | undefined): string {
  const apiKey = options?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OpenAI API key is required. Set OPENAI_API_KEY or configure models.providers.openai.apiKey.",
    );
  }
  return apiKey;
}

function createEmptyAssistantMessage(model: Model<"openai-responses">): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export const streamInniesOpenAIResponses: StreamFn = (model, context, rawOptions) => {
  const typedModel = model as Model<"openai-responses">;
  const options = (rawOptions ?? {}) as InniesStreamOptions;
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output = createEmptyAssistantMessage(typedModel);
    try {
      const response = await createInniesCompatibleFetch()(
        resolveResponsesUrl(typedModel.baseUrl),
        {
          method: "POST",
          headers: buildInniesRequestHeaders(typedModel, options),
          body: JSON.stringify(buildInniesResponsesParams(typedModel, context, options)),
          signal: options.signal,
        },
      );
      if (!response.ok) {
        throw new Error(await buildErrorMessage(response));
      }
      stream.push({ type: "start", partial: output });
      await processResponsesStream(
        parseInniesSse(response) as Parameters<typeof processResponsesStream>[0],
        output,
        stream,
        typedModel,
        {
          serviceTier: options.serviceTier,
          applyServiceTierPricing,
        },
      );
      if (options.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content as unknown as Array<Record<string, unknown>>) {
        delete block.index;
      }
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamInniesOpenAIResponsesSimple: StreamFn = (model, context, rawOptions) => {
  const options = (rawOptions ?? {}) as InniesStreamOptions;
  const apiKey = resolveOpenAiApiKey(options);
  const typedModel = model as Model<"openai-responses">;
  const reasoningEffort = supportsXhigh(typedModel)
    ? options.reasoning
    : clampReasoning(options.reasoning);
  return streamInniesOpenAIResponses(typedModel, context, {
    ...options,
    apiKey,
    reasoningEffort,
  } as unknown as Parameters<StreamFn>[2]);
};
