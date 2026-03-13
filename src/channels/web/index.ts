/* istanbul ignore file */
const REMOVED_MESSAGE = "WhatsApp/WebChat support has been removed from ActiveClaw.";

export const WA_WEB_AUTH_DIR = "";

export function logWebSelfId(): void {}

export function webAuthExists(): boolean {
  return false;
}

export async function createWaSocket(): Promise<never> {
  throw new Error(REMOVED_MESSAGE);
}

export async function loginWeb(): Promise<never> {
  throw new Error(REMOVED_MESSAGE);
}

export async function monitorWebChannel(): Promise<never> {
  throw new Error(REMOVED_MESSAGE);
}

export async function monitorWebInbox(): Promise<never> {
  throw new Error(REMOVED_MESSAGE);
}

export async function pickWebChannel(): Promise<never> {
  throw new Error(REMOVED_MESSAGE);
}

export async function sendMessageWhatsApp(): Promise<never> {
  throw new Error(REMOVED_MESSAGE);
}

export async function waitForWaConnection(): Promise<never> {
  throw new Error(REMOVED_MESSAGE);
}
