import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../../browser/control-service.js";
import { createBrowserRouteDispatcher } from "../../browser/routes/dispatcher.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type BrowserRequestParams = {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
};

function resolveRequestedProfile(params: {
  query?: Record<string, unknown>;
  body?: unknown;
}): string | undefined {
  const queryProfile =
    typeof params.query?.profile === "string" ? params.query.profile.trim() : undefined;
  if (queryProfile) {
    return queryProfile;
  }
  if (!params.body || typeof params.body !== "object") {
    return undefined;
  }
  const bodyProfile =
    "profile" in params.body && typeof params.body.profile === "string"
      ? params.body.profile.trim()
      : undefined;
  return bodyProfile || undefined;
}

export const browserHandlers: GatewayRequestHandlers = {
  "browser.request": async ({ params, respond }) => {
    const typed = params as BrowserRequestParams;
    const methodRaw = typeof typed.method === "string" ? typed.method.trim().toUpperCase() : "";
    const path = typeof typed.path === "string" ? typed.path.trim() : "";
    const query = typed.query && typeof typed.query === "object" ? typed.query : undefined;
    const body = typed.body;

    if (!methodRaw || !path) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "method and path are required"),
      );
      return;
    }
    if (methodRaw !== "GET" && methodRaw !== "POST" && methodRaw !== "DELETE") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "method must be GET, POST, or DELETE"),
      );
      return;
    }

    const ready = await startBrowserControlServiceFromConfig();
    if (!ready) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "browser control is disabled"));
      return;
    }

    let dispatcher;
    try {
      dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
      return;
    }

    const profile = resolveRequestedProfile({ query, body });
    const normalizedBody =
      body && typeof body === "object"
        ? {
            ...(body as Record<string, unknown>),
            ...(profile ? { profile } : {}),
          }
        : body;

    const result = await dispatcher.dispatch({
      method: methodRaw,
      path,
      query,
      body: normalizedBody,
    });

    if (result.status >= 400) {
      const message =
        result.body && typeof result.body === "object" && "error" in result.body
          ? String((result.body as { error?: unknown }).error)
          : `browser request failed (${result.status})`;
      const code = result.status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST;
      respond(false, undefined, errorShape(code, message, { details: result.body }));
      return;
    }

    respond(true, result.body);
  },
};
