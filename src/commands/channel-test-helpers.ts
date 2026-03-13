import { hubPlugin } from "../../extensions/hub/src/channel.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type { ChannelChoice } from "./onboard-types.js";
import { getChannelOnboardingAdapter } from "./onboarding/registry.js";
import type { ChannelOnboardingAdapter } from "./onboarding/types.js";

type ChannelOnboardingAdapterPatch = Partial<
  Pick<
    ChannelOnboardingAdapter,
    "configure" | "configureInteractive" | "configureWhenConfigured" | "getStatus"
  >
>;

type PatchedOnboardingAdapterFields = {
  configure?: ChannelOnboardingAdapter["configure"];
  configureInteractive?: ChannelOnboardingAdapter["configureInteractive"];
  configureWhenConfigured?: ChannelOnboardingAdapter["configureWhenConfigured"];
  getStatus?: ChannelOnboardingAdapter["getStatus"];
};

export function setDefaultChannelPluginRegistryForTests(): void {
  const channels = [
    { pluginId: "hub", plugin: hubPlugin, source: "test" },
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
  ] as unknown as Parameters<typeof createTestRegistry>[0];
  setActivePluginRegistry(createTestRegistry(channels));
}

export function patchChannelOnboardingAdapter(
  channel: ChannelChoice,
  patch: ChannelOnboardingAdapterPatch,
): () => void {
  const adapter = getChannelOnboardingAdapter(channel);
  if (!adapter) {
    throw new Error(`missing onboarding adapter for ${channel}`);
  }

  const previous: PatchedOnboardingAdapterFields = {};

  if (Object.prototype.hasOwnProperty.call(patch, "getStatus")) {
    previous.getStatus = adapter.getStatus;
    adapter.getStatus = patch.getStatus ?? adapter.getStatus;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configure")) {
    previous.configure = adapter.configure;
    adapter.configure = patch.configure ?? adapter.configure;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configureInteractive")) {
    previous.configureInteractive = adapter.configureInteractive;
    adapter.configureInteractive = patch.configureInteractive;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configureWhenConfigured")) {
    previous.configureWhenConfigured = adapter.configureWhenConfigured;
    adapter.configureWhenConfigured = patch.configureWhenConfigured;
  }

  return () => {
    if (Object.prototype.hasOwnProperty.call(patch, "getStatus")) {
      adapter.getStatus = previous.getStatus!;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configure")) {
      adapter.configure = previous.configure!;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configureInteractive")) {
      adapter.configureInteractive = previous.configureInteractive;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configureWhenConfigured")) {
      adapter.configureWhenConfigured = previous.configureWhenConfigured;
    }
  };
}
