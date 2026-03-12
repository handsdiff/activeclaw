import type { BaseProbeResult, DmPolicy, OpenClawConfig } from "openclaw/plugin-sdk/compat";

export type HubAccountConfig = {
  name?: string;
  enabled?: boolean;
  url?: string;
  agentId?: string;
  secret?: string;
  secretFile?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  pollTimeoutSec?: number;
};

export type HubConfig = HubAccountConfig & {
  accounts?: Record<string, HubAccountConfig>;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    hub?: HubConfig;
  };
};

export type HubInboundMessage = {
  messageId: string;
  from: string;
  text: string;
  timestamp: number;
};

export type HubProbe = BaseProbeResult<string> & {
  url: string;
  agentId: string;
  latencyMs?: number;
};
