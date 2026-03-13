import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "../auth.js";
import { authorizeGatewayBearerRequestOrReply } from "../http-auth-helpers.js";

export function isCanvasPath(_pathname: string): boolean {
  return false;
}

export async function authorizeCanvasRequest(_params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  clients: Set<unknown>;
  canvasCapability?: string;
  malformedScopedPath?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<GatewayAuthResult> {
  return { ok: false, reason: "unauthorized" };
}

export async function enforcePluginRouteGatewayAuth(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<boolean> {
  return await authorizeGatewayBearerRequestOrReply(params);
}
