import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import type { sendMessageTelegram } from "../telegram/send.js";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";

type RemovedChannelSend = (
  to: string,
  text: string,
  opts?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type CliDeps = {
  sendMessageTelegram: typeof sendMessageTelegram;
  sendMessageWhatsApp: RemovedChannelSend;
  sendMessageDiscord: RemovedChannelSend;
  sendMessageSlack: RemovedChannelSend;
  sendMessageSignal: RemovedChannelSend;
  sendMessageIMessage: RemovedChannelSend;
};

let telegramSenderRuntimePromise: Promise<typeof import("./deps-send-telegram.runtime.js")> | null =
  null;

function loadTelegramSenderRuntime() {
  telegramSenderRuntimePromise ??= import("./deps-send-telegram.runtime.js");
  return telegramSenderRuntimePromise;
}

async function removedChannelSend(): Promise<never> {
  throw new Error("This channel has been removed from ActiveClaw.");
}

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageTelegram: async (...args) => {
      const { sendMessageTelegram } = await loadTelegramSenderRuntime();
      return await sendMessageTelegram(...args);
    },
    sendMessageWhatsApp: removedChannelSend,
    sendMessageDiscord: removedChannelSend,
    sendMessageSlack: removedChannelSend,
    sendMessageSignal: removedChannelSend,
    sendMessageIMessage: removedChannelSend,
  };
}

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}

export function logWebSelfId(): void {}
