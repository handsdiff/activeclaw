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
  const { url, agentId, secret, abortSignal, onMessages, onError, onConnected } = opts;
  let attempt = 0;

  while (!abortSignal?.aborted) {
    try {
      const wsUrl = `${httpToWs(url)}/agents/${encodeURIComponent(agentId)}/ws`;
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("error", onErr);
          ws.removeEventListener("close", onClose);
          ws.removeEventListener("message", onMsg);
        };

        const onOpen = () => {
          ws.send(JSON.stringify({ secret }));
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
              attempt = 0;
              onConnected?.();
              return;
            }

            if (!data.ok && data.error) {
              cleanup();
              reject(new Error(`Hub auth failed: ${data.error}`));
              return;
            }

            if (data.type === "message" && data.data) {
              const msg: HubInboundMessage = {
                messageId: data.data.messageId || `hub-${crypto.randomUUID()}`,
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
      onError?.(error);
    }

    if (abortSignal?.aborted) break;
    const delay = computeReconnectDelay(attempt);
    attempt++;
    try {
      await setTimeout(delay, undefined, { signal: abortSignal });
    } catch {
      break;
    }
  }
}
