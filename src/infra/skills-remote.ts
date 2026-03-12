import type { SkillEligibilityContext } from "../agents/skills/types.js";
import type { OpenClawConfig } from "../config/config.js";

export function setSkillsRemoteRegistry(_registry: unknown) {}

export async function primeRemoteSkillsCache() {}

export function recordRemoteNodeInfo(_node: {
  nodeId: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  remoteIp?: string;
}) {}

export function recordRemoteNodeBins(_nodeId: string, _bins: string[]) {}

export function removeRemoteNodeInfo(_nodeId: string) {}

export async function refreshRemoteNodeBins(_params: {
  nodeId: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  cfg: OpenClawConfig;
  timeoutMs?: number;
}) {}

export function getRemoteSkillEligibility(): SkillEligibilityContext["remote"] | undefined {
  return undefined;
}

export async function refreshRemoteBinsForConnectedNodes(_cfg: OpenClawConfig) {}
