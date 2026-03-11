const EPHEMERAL_CONTEXT_BEGIN_MARKER = "<<<BEGIN_OPENCLAW_EPHEMERAL_CONTEXT>>>";
const EPHEMERAL_CONTEXT_END_MARKER = "<<<END_OPENCLAW_EPHEMERAL_CONTEXT>>>";
const EPHEMERAL_LITERAL_BEGIN_MARKER = "[literal_openclaw_ephemeral_begin_marker]";
const EPHEMERAL_LITERAL_END_MARKER = "[literal_openclaw_ephemeral_end_marker]";

function escapeEphemeralPromptBody(text: string): string {
  return text
    .replaceAll(EPHEMERAL_CONTEXT_BEGIN_MARKER, EPHEMERAL_LITERAL_BEGIN_MARKER)
    .replaceAll(EPHEMERAL_CONTEXT_END_MARKER, EPHEMERAL_LITERAL_END_MARKER);
}

export function buildEphemeralPromptBlock(params: {
  heading: string;
  description: string;
  body: string;
}): string {
  const body = escapeEphemeralPromptBody(params.body.trim());
  if (!body) {
    return "";
  }
  return [
    params.heading.trim(),
    params.description.trim(),
    "",
    EPHEMERAL_CONTEXT_BEGIN_MARKER,
    body,
    EPHEMERAL_CONTEXT_END_MARKER,
  ].join("\n");
}

export function stripEphemeralPromptBlocks(text: string): { text: string; changed: boolean } {
  const normalized = text.replace(/\r\n/g, "\n");
  const pattern =
    /(^|\n{1,2})(?:Ephemeral runtime context for this turn only\.\nThis context is runtime-generated, not user-authored conversation history\.|Ephemeral runtime system events for this turn only\.\nThese events are runtime-generated context, not user-authored conversation history\.)\n\n<<<BEGIN_OPENCLAW_EPHEMERAL_CONTEXT>>>\n[\s\S]*?\n<<<END_OPENCLAW_EPHEMERAL_CONTEXT>>>(?:\n{1,2}|$)/g;
  const stripped = normalized.replace(pattern, (_match, prefix: string) => prefix);
  if (stripped === normalized) {
    return { text, changed: false };
  }
  return {
    text: stripped.replace(/\n{3,}/g, "\n\n").trim(),
    changed: true,
  };
}

export { EPHEMERAL_CONTEXT_BEGIN_MARKER, EPHEMERAL_CONTEXT_END_MARKER };
