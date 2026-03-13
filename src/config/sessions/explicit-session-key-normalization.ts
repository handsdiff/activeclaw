import type { MsgContext } from "../../auto-reply/templating.js";

export function normalizeExplicitSessionKey(sessionKey: string, ctx: MsgContext): string {
  void ctx;
  return sessionKey.trim().toLowerCase();
}
