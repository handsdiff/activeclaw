import { loadConfig } from "../../config/config.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { dockerContainerState, execDocker } from "./docker.js";
import { readRegistry, removeRegistryEntry, type SandboxRegistryEntry } from "./registry.js";
import { resolveSandboxAgentId } from "./shared.js";

export type SandboxContainerInfo = SandboxRegistryEntry & {
  running: boolean;
  imageMatch: boolean;
};

async function listSandboxRegistryItems<
  TEntry extends { containerName: string; image: string; sessionKey: string },
>(params: {
  read: () => Promise<{ entries: TEntry[] }>;
  resolveConfiguredImage: (agentId?: string) => string;
}): Promise<Array<TEntry & { running: boolean; imageMatch: boolean }>> {
  const registry = await params.read();
  const results: Array<TEntry & { running: boolean; imageMatch: boolean }> = [];

  for (const entry of registry.entries) {
    const state = await dockerContainerState(entry.containerName);
    // Get actual image from container.
    let actualImage = entry.image;
    if (state.exists) {
      try {
        const result = await execDocker(
          ["inspect", "-f", "{{.Config.Image}}", entry.containerName],
          { allowFailure: true },
        );
        if (result.code === 0) {
          actualImage = result.stdout.trim();
        }
      } catch {
        // ignore
      }
    }
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const configuredImage = params.resolveConfiguredImage(agentId);
    results.push({
      ...entry,
      image: actualImage,
      running: state.running,
      imageMatch: actualImage === configuredImage,
    });
  }

  return results;
}

export async function listSandboxContainers(): Promise<SandboxContainerInfo[]> {
  const config = loadConfig();
  return listSandboxRegistryItems<SandboxRegistryEntry>({
    read: readRegistry,
    resolveConfiguredImage: (agentId) => resolveSandboxConfigForAgent(config, agentId).docker.image,
  });
}

export async function removeSandboxContainer(containerName: string): Promise<void> {
  try {
    await execDocker(["rm", "-f", containerName], { allowFailure: true });
  } catch {
    // ignore removal failures
  }
  await removeRegistryEntry(containerName);
}
