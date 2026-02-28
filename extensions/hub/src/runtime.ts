import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setHubRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getHubRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Hub runtime not initialized");
  }
  return runtime;
}
