import type { ReplyPayload } from "../types.js";

// LINE support has been removed. Keep legacy directive stripping so prompts
// authored against older builds do not leak raw markers into live replies.
export function hasLineDirectives(text?: string | null): boolean {
  return typeof text === "string" && /\[\[[\s\S]*?\]\]/.test(text);
}

export function parseLineDirectives(payload: ReplyPayload): ReplyPayload {
  const text = payload.text;
  if (!hasLineDirectives(text)) {
    return payload;
  }
  return {
    ...payload,
    text: (text ?? "")
      .replace(/\[\[[\s\S]*?\]\]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}
