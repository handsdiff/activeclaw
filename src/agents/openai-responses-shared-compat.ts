import {
  calculateCost,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Tool,
  type Usage,
} from "@mariozechner/pi-ai";

type ResponseServiceTier = "auto" | "default" | "flex" | "scale" | "priority";
type ResponseStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled"
  | "in_progress"
  | "queued";
type ResponseInputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; detail: "auto"; image_url: string };
type ResponseOutputTextPart = {
  type: "output_text";
  text: string;
  annotations: unknown[];
};
type ResponseRefusalPart = {
  type: "refusal";
  refusal: string;
};
type ResponseMessagePart = ResponseOutputTextPart | ResponseRefusalPart;
type ResponseInputItem =
  | { role: "system" | "developer"; content: string }
  | { role: "user"; content: ResponseInputPart[] }
  | {
      type: "message";
      role: "assistant";
      content: ResponseMessagePart[];
      status: "completed";
      id: string;
      phase?: "commentary" | "final_answer";
    }
  | {
      type: "function_call";
      id?: string;
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };
type ResponseInput = ResponseInputItem[];
type OpenAITool = {
  type: "function";
  name: string;
  description: string;
  parameters: Tool["parameters"];
  strict: boolean | null;
};
type ResponseReasoningSummaryPart = { text: string };
type ResponseReasoningItem = {
  type: "reasoning";
  summary?: ResponseReasoningSummaryPart[];
};
type ResponseMessageItem = {
  type: "message";
  id: string;
  phase?: "commentary" | "final_answer";
  content: ResponseMessagePart[];
};
type ResponseFunctionCallItem = {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments?: string;
};
type ResponseOutputItem = ResponseReasoningItem | ResponseMessageItem | ResponseFunctionCallItem;
type ResponseStreamEvent =
  | { type: "response.output_item.added"; item: ResponseOutputItem }
  | { type: "response.reasoning_summary_part.added"; part: ResponseReasoningSummaryPart }
  | { type: "response.reasoning_summary_text.delta"; delta: string }
  | { type: "response.reasoning_summary_part.done" }
  | { type: "response.content_part.added"; part: ResponseMessagePart }
  | { type: "response.output_text.delta"; delta: string }
  | { type: "response.refusal.delta"; delta: string }
  | { type: "response.function_call_arguments.delta"; delta: string }
  | { type: "response.function_call_arguments.done"; arguments: string }
  | { type: "response.output_item.done"; item: ResponseOutputItem }
  | {
      type: "response.completed";
      response?: {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          input_tokens_details?: {
            cached_tokens?: number;
          };
        };
        service_tier?: ResponseServiceTier;
        status?: ResponseStatus;
      };
    }
  | { type: "error"; code: string; message: string }
  | { type: "response.failed" };
type PartialToolCallBlock = ToolCallBlock & { partialJson?: string };

export interface OpenAIResponsesStreamOptions {
  serviceTier?: ResponseServiceTier;
  applyServiceTierPricing?: (usage: Usage, serviceTier: ResponseServiceTier | undefined) => void;
}

export interface ConvertResponsesMessagesOptions {
  includeSystemPrompt?: boolean;
}

export interface ConvertResponsesToolsOptions {
  strict?: boolean | null;
}

type AssistantTurn = Extract<Context["messages"][number], { role: "assistant" }>;
type ToolResultTurn = Extract<Context["messages"][number], { role: "toolResult" }>;
type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

type TextSignature = {
  id: string;
  phase?: "commentary" | "final_answer";
};

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function shortHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function encodeTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  const payload: { v: 1; id: string; phase?: "commentary" | "final_answer" } = {
    v: 1,
    id,
  };
  if (phase) {
    payload.phase = phase;
  }
  return JSON.stringify(payload);
}

function parseTextSignature(signature: string | undefined): TextSignature | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown };
      if (parsed.v === 1 && typeof parsed.id === "string") {
        if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
          return { id: parsed.id, phase: parsed.phase };
        }
        return { id: parsed.id };
      }
    } catch {
      // Fall through to the legacy plain-string signature form.
    }
  }
  return { id: signature };
}

function transformMessages<TApi extends Api>(
  messages: Context["messages"],
  model: Model<TApi>,
  normalizeToolCallId?: (id: string, model: Model<TApi>, assistantMsg: AssistantTurn) => string,
): Context["messages"] {
  const toolCallIdMap = new Map<string, string>();

  const transformed: Context["messages"] = messages.map((msg) => {
    if (msg.role === "user") {
      return msg;
    }

    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return { ...msg, toolCallId: normalizedId };
      }
      return msg;
    }

    const assistantMsg = msg;
    const isSameModel =
      assistantMsg.provider === model.provider &&
      assistantMsg.api === model.api &&
      assistantMsg.model === model.id;

    const transformedContent: AssistantTurn["content"] = [];
    for (const block of assistantMsg.content) {
      if (block.type === "thinking") {
        if (block.redacted) {
          if (isSameModel) {
            transformedContent.push(block);
          }
          continue;
        }
        if (isSameModel && block.thinkingSignature) {
          transformedContent.push(block);
          continue;
        }
        if (!block.thinking || block.thinking.trim() === "") {
          continue;
        }
        if (isSameModel) {
          transformedContent.push(block);
          continue;
        }
        transformedContent.push({ type: "text", text: block.thinking });
        continue;
      }

      if (block.type === "text") {
        if (isSameModel) {
          transformedContent.push(block);
          continue;
        }
        transformedContent.push({ type: "text", text: block.text });
        continue;
      }

      if (block.type === "toolCall") {
        let normalizedToolCall: ToolCallBlock = block;
        if (!isSameModel && block.thoughtSignature) {
          normalizedToolCall = { ...block };
          delete normalizedToolCall.thoughtSignature;
        }
        if (!isSameModel && normalizeToolCallId) {
          const normalizedId = normalizeToolCallId(block.id, model, assistantMsg);
          if (normalizedId !== block.id) {
            toolCallIdMap.set(block.id, normalizedId);
            normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
          }
        }
        transformedContent.push(normalizedToolCall);
        continue;
      }

      transformedContent.push(block);
    }

    return {
      ...assistantMsg,
      content: transformedContent,
    } satisfies AssistantTurn;
  });

  const result: Context["messages"] = [];
  let pendingToolCalls: ToolCallBlock[] = [];
  let existingToolResultIds = new Set<string>();

  for (let i = 0; i < transformed.length; i += 1) {
    const msg = transformed[i];
    if (msg.role === "assistant") {
      if (pendingToolCalls.length > 0) {
        for (const tc of pendingToolCalls) {
          if (!existingToolResultIds.has(tc.id)) {
            result.push({
              role: "toolResult",
              toolCallId: tc.id,
              toolName: tc.name,
              content: [{ type: "text", text: "No result provided" }],
              isError: true,
              timestamp: Date.now(),
            });
          }
        }
        pendingToolCalls = [];
        existingToolResultIds = new Set();
      }

      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }

      const toolCalls = msg.content.filter(
        (block): block is ToolCallBlock => block.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }
      result.push(msg);
      continue;
    }

    if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
      continue;
    }

    if (pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        if (!existingToolResultIds.has(tc.id)) {
          result.push({
            role: "toolResult",
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: "text", text: "No result provided" }],
            isError: true,
            timestamp: Date.now(),
          });
        }
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
    result.push(msg);
  }

  return result;
}

export function convertResponsesMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
): ResponseInput {
  const messages: ResponseInput = [];

  const normalizeToolCallId = (id: string) => {
    if (!allowedToolCallProviders.has(model.provider)) {
      return id;
    }
    if (!id.includes("|")) {
      return id;
    }
    const [callId, itemId] = id.split("|");
    const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
    let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!sanitizedItemId.startsWith("fc")) {
      sanitizedItemId = `fc_${sanitizedItemId}`;
    }
    let normalizedCallId =
      sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
    let normalizedItemId =
      sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
    normalizedCallId = normalizedCallId.replace(/_+$/, "");
    normalizedItemId = normalizedItemId.replace(/_+$/, "");
    return `${normalizedCallId}|${normalizedItemId}`;
  };

  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    messages.push({
      role: model.reasoning ? "developer" : "system",
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
        });
      } else {
        const content = msg.content.map((item) => {
          if (item.type === "text") {
            return {
              type: "input_text" as const,
              text: sanitizeSurrogates(item.text),
            };
          }
          return {
            type: "input_image" as const,
            detail: "auto" as const,
            image_url: `data:${item.mimeType};base64,${item.data}`,
          };
        });
        const filteredContent = model.input.includes("image")
          ? content
          : content.filter((item) => item.type !== "input_image");
        if (filteredContent.length === 0) {
          continue;
        }
        messages.push({
          role: "user",
          content: filteredContent,
        });
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      const isDifferentModel =
        msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;

      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            output.push(JSON.parse(block.thinkingSignature) as ResponseInput[number]);
          }
          continue;
        }

        if (block.type === "text") {
          const parsedSignature = parseTextSignature(block.textSignature);
          let msgId = parsedSignature?.id;
          if (!msgId) {
            msgId = `msg_${msgIndex}`;
          } else if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          output.push({
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] },
            ],
            status: "completed",
            id: msgId,
            phase: parsedSignature?.phase,
          });
          continue;
        }

        if (block.type === "toolCall") {
          const [callId, itemIdRaw] = block.id.split("|");
          let itemId: string | undefined = itemIdRaw;
          if (isDifferentModel && itemId?.startsWith("fc_")) {
            itemId = undefined;
          }
          output.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
        }
      }

      if (output.length === 0) {
        continue;
      }
      messages.push(...output);
    } else {
      const textResult = msg.content
        .filter(
          (block): block is Extract<ToolResultTurn["content"][number], { type: "text" }> =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("\n");
      const hasImages = msg.content.some((block) => block.type === "image");
      const hasText = textResult.length > 0;
      const [callId] = msg.toolCallId.split("|");
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
      });

      if (hasImages && model.input.includes("image")) {
        const contentParts: Array<
          | { type: "input_text"; text: string }
          | { type: "input_image"; detail: "auto"; image_url: string }
        > = [{ type: "input_text", text: "Attached image(s) from tool result:" }];
        for (const block of msg.content) {
          if (block.type === "image") {
            contentParts.push({
              type: "input_image",
              detail: "auto",
              image_url: `data:${block.mimeType};base64,${block.data}`,
            });
          }
        }
        messages.push({
          role: "user",
          content: contentParts,
        });
      }
    }
    msgIndex += 1;
  }

  return messages;
}

export function convertResponsesTools(
  tools: Tool[],
  options?: ConvertResponsesToolsOptions,
): OpenAITool[] {
  const strict = options?.strict === undefined ? false : options.strict;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict,
  }));
}

function mapStopReason(status: ResponseStatus | undefined): AssistantMessage["stopReason"] {
  if (!status) {
    return "stop";
  }
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
  }
}

export async function processResponsesStream<TApi extends Api>(
  openaiStream: AsyncIterable<ResponseStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
  options?: OpenAIResponsesStreamOptions,
): Promise<void> {
  let currentItem: ResponseOutputItem | null = null;
  let currentBlock: AssistantMessage["content"][number] | PartialToolCallBlock | null = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;

  for await (const event of openaiStream) {
    if (event.type === "response.output_item.added") {
      const item = event.item;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: {},
          partialJson: item.arguments || "",
        };
        output.content.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
      }
      continue;
    }

    if (event.type === "response.reasoning_summary_part.added") {
      if (currentItem?.type === "reasoning") {
        currentItem.summary = currentItem.summary || [];
        currentItem.summary.push(event.part);
      }
      continue;
    }

    if (event.type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
      continue;
    }

    if (event.type === "response.reasoning_summary_part.done") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += "\n\n";
          lastPart.text += "\n\n";
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: "\n\n",
            partial: output,
          });
        }
      }
      continue;
    }

    if (event.type === "response.content_part.added") {
      if (currentItem?.type === "message") {
        currentItem.content = currentItem.content || [];
        if (event.part.type === "output_text" || event.part.type === "refusal") {
          currentItem.content.push(event.part);
        }
      }
      continue;
    }

    if (event.type === "response.output_text.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        const lastPart = currentItem.content?.[currentItem.content.length - 1];
        if (lastPart?.type === "output_text") {
          currentBlock.text += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
      continue;
    }

    if (event.type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        const lastPart = currentItem.content?.[currentItem.content.length - 1];
        if (lastPart?.type === "refusal") {
          currentBlock.text += event.delta;
          lastPart.refusal += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        const toolCallBlock = currentBlock as AssistantMessage["content"][number] & {
          partialJson?: string;
        };
        toolCallBlock.partialJson = `${toolCallBlock.partialJson ?? ""}${event.delta}`;
        currentBlock.arguments = parseStreamingJson(toolCallBlock.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.done") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        const toolCallBlock = currentBlock as AssistantMessage["content"][number] & {
          partialJson?: string;
        };
        toolCallBlock.partialJson = event.arguments;
        currentBlock.arguments = parseStreamingJson(toolCallBlock.partialJson);
      }
      continue;
    }

    if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking =
          item.summary?.map((summary: ResponseReasoningSummaryPart) => summary.text).join("\n\n") ||
          "";
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: currentBlock.thinking,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = item.content
          .map((part: ResponseMessagePart) =>
            part.type === "output_text" ? part.text : part.refusal,
          )
          .join("");
        currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
        stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const toolCallBlock =
          currentBlock?.type === "toolCall"
            ? (currentBlock as AssistantMessage["content"][number] & { partialJson?: string })
            : null;
        const args = toolCallBlock?.partialJson
          ? parseStreamingJson(toolCallBlock.partialJson)
          : parseStreamingJson(item.arguments || "{}");
        const toolCall = {
          type: "toolCall" as const,
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: args,
        };
        currentBlock = null;
        stream.push({
          type: "toolcall_end",
          contentIndex: blockIndex(),
          toolCall,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.completed") {
      const response = event.response;
      if (response?.usage) {
        const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
        output.usage = {
          input: (response.usage.input_tokens || 0) - cachedTokens,
          output: response.usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          totalTokens: response.usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      calculateCost(model, output.usage);
      if (options?.applyServiceTierPricing) {
        const serviceTier = response?.service_tier ?? options.serviceTier;
        options.applyServiceTierPricing(output.usage, serviceTier);
      }
      output.stopReason = mapStopReason(response?.status);
      if (
        output.content.some((block) => block.type === "toolCall") &&
        output.stopReason === "stop"
      ) {
        output.stopReason = "toolUse";
      }
      continue;
    }

    if (event.type === "error") {
      throw new Error(
        event.message ? `Error Code ${event.code}: ${event.message}` : "Unknown error",
      );
    }

    if (event.type === "response.failed") {
      throw new Error("Unknown error");
    }
  }
}
