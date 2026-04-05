import { setTimeout } from "node:timers/promises";
import type { HubInboundMessage } from "./types.js";

export type WsHubOptions = {
  url: string;
  agentId: string;
  secret: string;
  abortSignal?: AbortSignal;
  onMessages: (messages: HubInboundMessage[]) => void | Promise<void>;
  onError?: (error: Error) => void;
  onConnected?: () => void;
  fallbackAfterFailures?: number;
  onFallbackToPoll?: (reason: string) => void | Promise<void>;
};

function httpToWs(url: string): string {
  return url.replace(/^http/, "ws");
}

function computeReconnectDelay(attempt: number): number {
  const initialMs = 1_000;
  const maxMs = 60_000;
  const base = Math.min(initialMs * 2 ** attempt, maxMs);
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return Math.max(initialMs, Math.round(base + jitter));
}

export async function connectHubWebSocket(opts: WsHubOptions): Promise<void> {
  const {
    url,
    agentId,
    secret,
    abortSignal,
    onMessages,
    onError,
    onConnected,
    fallbackAfterFailures = 3,
    onFallbackToPoll,
  } = opts;
  let attempt = 0;
  let consecutiveFailures = 0;

  // Initial delay on first attempt to allow Hub server to start
  if (attempt === 0) {
    try {
      await setTimeout(5_000, undefined, { signal: abortSignal });
    } catch {
      return;
    }
  }

  while (!abortSignal?.aborted) {
    let failureKind: "transport" | "auth" = "transport";
    try {
      const wsUrl = `${httpToWs(url)}/agents/${encodeURIComponent(agentId)}/ws`;
      console.error(`[HUB-WS-DEBUG] connecting to ${wsUrl}`);
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        let authTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
        const cleanup = () => {
          if (authTimer) {
            clearTimeout(authTimer);
            authTimer = undefined;
          }
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("error", onErr);
          ws.removeEventListener("close", onClose);
          ws.removeEventListener("message", onMsg);
        };

        const onOpen = () => {
          ws.send(JSON.stringify({ secret }));
          authTimer = globalThis.setTimeout(() => {
            cleanup();
            try {
              ws.close();
            } catch {}
            reject(new Error("Hub auth timeout"));
          }, 10_000);
        };

        const onErr = () => {
          cleanup();
          reject(new Error("WebSocket error"));
        };

        const onClose = () => {
          cleanup();
          resolve();
        };

        const onMsg = async (ev: MessageEvent) => {
          try {
            const data = JSON.parse(String(ev.data));

            if (data.type === "auth" && data.ok) {
              if (authTimer) {
                clearTimeout(authTimer);
                authTimer = undefined;
              }
              consecutiveFailures = 0;
              attempt = 0;
              onConnected?.();
              return;
            }

            if (!data.ok && data.error) {
              failureKind = "auth";
              cleanup();
              reject(new Error(`Hub auth failed: ${data.error}`));
              return;
            }

            if (data.type === "message" && data.data) {
              const msg: HubInboundMessage = {
                messageId:
                  typeof data.data.messageId === "string" ? data.data.messageId.trim() : "",
                from: data.data.from,
                text: data.data.text,
                timestamp:
                  typeof data.data.timestamp === "number"
                    ? data.data.timestamp
                    : typeof data.data.timestamp === "string"
                      ? new Date(data.data.timestamp).getTime() || Date.now()
                      : Date.now(),
              };
              await onMessages([msg]);
            }
          } catch (err) {
            onError?.(err instanceof Error ? err : new Error(String(err)));
          }
        };

        ws.addEventListener("open", onOpen);
        ws.addEventListener("error", onErr);
        ws.addEventListener("close", onClose);
        ws.addEventListener("message", onMsg);

        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 25_000);

        abortSignal?.addEventListener(
          "abort",
          () => {
            clearInterval(pingInterval);
            cleanup();
            ws.close();
            resolve();
          },
          { once: true },
        );

        ws.addEventListener("close", () => clearInterval(pingInterval), { once: true });
      });
    } catch (err) {
      if (abortSignal?.aborted) break;
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.message.startsWith("Hub auth failed:")) {
        failureKind = "auth";
      }
      onError?.(error);
    }

    if (abortSignal?.aborted) break;

    if (failureKind !== "auth") {
      consecutiveFailures++;
    }

    if (
      failureKind !== "auth" &&
      fallbackAfterFailures > 0 &&
      consecutiveFailures >= fallbackAfterFailures &&
      onFallbackToPoll
    ) {
      await onFallbackToPoll?.(
        `ws transport failed ${consecutiveFailures} consecutive times; falling back to poll`,
      );
      consecutiveFailures = 0;
      attempt = 0;
    }

    const delay = computeReconnectDelay(attempt);
    attempt++;
    try {
      await setTimeout(delay, undefined, { signal: abortSignal });
    } catch {
      break;
    }
  }
}
