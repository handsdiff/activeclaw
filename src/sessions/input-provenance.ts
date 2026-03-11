import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const INPUT_PROVENANCE_KIND_VALUES = [
  "external_user",
  "inter_session",
  "internal_system",
] as const;

export type InputProvenanceKind = (typeof INPUT_PROVENANCE_KIND_VALUES)[number];

export const INPUT_PROVENANCE_PERSISTENCE_VALUES = ["persist", "ephemeral"] as const;

export type InputProvenancePersistence = (typeof INPUT_PROVENANCE_PERSISTENCE_VALUES)[number];

export type InputProvenance = {
  kind: InputProvenanceKind;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  persistence?: InputProvenancePersistence;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isInputProvenanceKind(value: unknown): value is InputProvenanceKind {
  return (
    typeof value === "string" && (INPUT_PROVENANCE_KIND_VALUES as readonly string[]).includes(value)
  );
}

function isInputProvenancePersistence(value: unknown): value is InputProvenancePersistence {
  return (
    typeof value === "string" &&
    (INPUT_PROVENANCE_PERSISTENCE_VALUES as readonly string[]).includes(value)
  );
}

export function normalizeInputProvenance(value: unknown): InputProvenance | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!isInputProvenanceKind(record.kind)) {
    return undefined;
  }
  return {
    kind: record.kind,
    sourceSessionKey: normalizeOptionalString(record.sourceSessionKey),
    sourceChannel: normalizeOptionalString(record.sourceChannel),
    sourceTool: normalizeOptionalString(record.sourceTool),
    persistence: isInputProvenancePersistence(record.persistence) ? record.persistence : undefined,
  };
}

export function applyInputProvenanceToUserMessage(
  message: AgentMessage,
  inputProvenance: InputProvenance | undefined,
): AgentMessage {
  if (!inputProvenance) {
    return message;
  }
  if ((message as { role?: unknown }).role !== "user") {
    return message;
  }
  const existing = normalizeInputProvenance((message as { provenance?: unknown }).provenance);
  if (existing) {
    return message;
  }
  return {
    ...(message as unknown as Record<string, unknown>),
    provenance: inputProvenance,
  } as unknown as AgentMessage;
}

export function isInterSessionInputProvenance(value: unknown): boolean {
  return normalizeInputProvenance(value)?.kind === "inter_session";
}

export function isEphemeralInputProvenance(value: unknown): boolean {
  return normalizeInputProvenance(value)?.persistence === "ephemeral";
}

export function hasInterSessionUserProvenance(
  message: { role?: unknown; provenance?: unknown } | undefined,
): boolean {
  if (!message || message.role !== "user") {
    return false;
  }
  return isInterSessionInputProvenance(message.provenance);
}
