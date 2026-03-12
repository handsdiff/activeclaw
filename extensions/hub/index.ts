import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/compat";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/compat";
import { hubPlugin } from "./src/channel.js";
import { setHubRuntime } from "./src/runtime.js";

const plugin = {
  id: "hub",
  name: "Hub",
  description: "Hub channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setHubRuntime(api.runtime);
    api.registerChannel({ plugin: hubPlugin as ChannelPlugin });
  },
};

export default plugin;
