import type { ExecAsk, ExecHost, ExecSecurity } from "../../../infra/exec-approvals.js";
import { skipDirectiveArgPrefix, takeDirectiveToken } from "../directive-parsing.js";

type ExecDirectiveParse = {
  cleaned: string;
  hasDirective: boolean;
  execHost?: ExecHost;
  execSecurity?: ExecSecurity;
  execAsk?: ExecAsk;
  rawExecHost?: string;
  rawExecSecurity?: string;
  rawExecAsk?: string;
  hasExecOptions: boolean;
  invalidHost: boolean;
  invalidSecurity: boolean;
  invalidAsk: boolean;
};

function normalizeExecHost(value?: string): ExecHost | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "gateway") {
    return normalized;
  }
  return undefined;
}

function normalizeExecSecurity(value?: string): ExecSecurity | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return undefined;
}

function normalizeExecAsk(value?: string): ExecAsk | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized as ExecAsk;
  }
  return undefined;
}

function parseExecDirectiveArgs(raw: string): Omit<
  ExecDirectiveParse,
  "cleaned" | "hasDirective"
> & {
  consumed: number;
} {
  const len = raw.length;
  let i = skipDirectiveArgPrefix(raw);
  let consumed = i;
  let execHost: ExecHost | undefined;
  let execSecurity: ExecSecurity | undefined;
  let execAsk: ExecAsk | undefined;
  let rawExecHost: string | undefined;
  let rawExecSecurity: string | undefined;
  let rawExecAsk: string | undefined;
  let hasExecOptions = false;
  let invalidHost = false;
  let invalidSecurity = false;
  let invalidAsk = false;

  const takeToken = (): string | null => {
    const res = takeDirectiveToken(raw, i);
    i = res.nextIndex;
    return res.token;
  };

  const splitToken = (token: string): { key: string; value: string } | null => {
    const eq = token.indexOf("=");
    const colon = token.indexOf(":");
    const idx = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
    if (idx === -1) {
      return null;
    }
    const key = token.slice(0, idx).trim().toLowerCase();
    const value = token.slice(idx + 1).trim();
    if (!key) {
      return null;
    }
    return { key, value };
  };

  while (i < len) {
    const token = takeToken();
    if (!token) {
      break;
    }
    const parsed = splitToken(token);
    if (!parsed) {
      break;
    }
    const { key, value } = parsed;
    if (key === "host") {
      rawExecHost = value;
      execHost = normalizeExecHost(value);
      if (!execHost) {
        invalidHost = true;
      }
      hasExecOptions = true;
      consumed = i;
      continue;
    }
    if (key === "security") {
      rawExecSecurity = value;
      execSecurity = normalizeExecSecurity(value);
      if (!execSecurity) {
        invalidSecurity = true;
      }
      hasExecOptions = true;
      consumed = i;
      continue;
    }
    if (key === "ask") {
      rawExecAsk = value;
      execAsk = normalizeExecAsk(value);
      if (!execAsk) {
        invalidAsk = true;
      }
      hasExecOptions = true;
      consumed = i;
      continue;
    }
    break;
  }

  return {
    consumed,
    execHost,
    execSecurity,
    execAsk,
    rawExecHost,
    rawExecSecurity,
    rawExecAsk,
    hasExecOptions,
    invalidHost,
    invalidSecurity,
    invalidAsk,
  };
}

export function extractExecDirective(body?: string): ExecDirectiveParse {
  if (!body) {
    return {
      cleaned: "",
      hasDirective: false,
      hasExecOptions: false,
      invalidHost: false,
      invalidSecurity: false,
      invalidAsk: false,
    };
  }
  const re = /(?:^|\s)\/exec(?=$|\s|:)/i;
  const match = re.exec(body);
  if (!match) {
    return {
      cleaned: body.trim(),
      hasDirective: false,
      hasExecOptions: false,
      invalidHost: false,
      invalidSecurity: false,
      invalidAsk: false,
    };
  }
  const start = match.index + match[0].indexOf("/exec");
  const argsStart = start + "/exec".length;
  const parsed = parseExecDirectiveArgs(body.slice(argsStart));
  const cleanedRaw = `${body.slice(0, start)} ${body.slice(argsStart + parsed.consumed)}`;
  const cleaned = cleanedRaw.replace(/\s+/g, " ").trim();
  return {
    cleaned,
    hasDirective: true,
    execHost: parsed.execHost,
    execSecurity: parsed.execSecurity,
    execAsk: parsed.execAsk,
    rawExecHost: parsed.rawExecHost,
    rawExecSecurity: parsed.rawExecSecurity,
    rawExecAsk: parsed.rawExecAsk,
    hasExecOptions: parsed.hasExecOptions,
    invalidHost: parsed.invalidHost,
    invalidSecurity: parsed.invalidSecurity,
    invalidAsk: parsed.invalidAsk,
  };
}
