import { confirm as clackConfirm } from "@clack/prompts";
import {
  listSandboxContainers,
  removeSandboxContainer,
  type SandboxContainerInfo,
} from "../agents/sandbox.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  displayContainers,
  displayRecreatePreview,
  displayRecreateResult,
  displaySummary,
} from "./sandbox-display.js";

// --- Types ---

type SandboxListOptions = {
  json: boolean;
};

type SandboxRecreateOptions = {
  all: boolean;
  session?: string;
  agent?: string;
  force: boolean;
};

type FilteredContainers = SandboxContainerInfo[];

// --- List Command ---

export async function sandboxListCommand(
  opts: SandboxListOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const containers = await listSandboxContainers().catch(() => []);

  if (opts.json) {
    runtime.log(JSON.stringify({ containers }, null, 2));
    return;
  }

  displayContainers(containers, runtime);
  displaySummary(containers, runtime);
}

// --- Recreate Command ---

export async function sandboxRecreateCommand(
  opts: SandboxRecreateOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  if (!validateRecreateOptions(opts, runtime)) {
    return;
  }

  const filtered = await fetchAndFilterContainers(opts);

  if (filtered.length === 0) {
    runtime.log("No containers found matching the criteria.");
    return;
  }

  displayRecreatePreview(filtered, runtime);

  if (!opts.force && !(await confirmRecreate())) {
    runtime.log("Cancelled.");
    return;
  }

  const result = await removeContainers(filtered, runtime);
  displayRecreateResult(result, runtime);

  if (result.failCount > 0) {
    runtime.exit(1);
  }
}

// --- Validation ---

function validateRecreateOptions(opts: SandboxRecreateOptions, runtime: RuntimeEnv): boolean {
  if (!opts.all && !opts.session && !opts.agent) {
    runtime.error("Please specify --all, --session <key>, or --agent <id>");
    runtime.exit(1);
    return false;
  }

  const exclusiveCount = [opts.all, opts.session, opts.agent].filter(Boolean).length;
  if (exclusiveCount > 1) {
    runtime.error("Please specify only one of: --all, --session, --agent");
    runtime.exit(1);
    return false;
  }

  return true;
}

// --- Filtering ---

async function fetchAndFilterContainers(opts: SandboxRecreateOptions): Promise<FilteredContainers> {
  const allContainers = await listSandboxContainers().catch(() => []);

  let containers = allContainers;

  if (opts.session) {
    containers = containers.filter((c) => c.sessionKey === opts.session);
  } else if (opts.agent) {
    const matchesAgent = createAgentMatcher(opts.agent);
    containers = containers.filter(matchesAgent);
  }

  return containers;
}

function createAgentMatcher(agentId: string) {
  const agentPrefix = `agent:${agentId}`;
  return (item: SandboxContainerInfo) =>
    item.sessionKey === agentPrefix || item.sessionKey.startsWith(`${agentPrefix}:`);
}

// --- Container Operations ---

async function confirmRecreate(): Promise<boolean> {
  const result = await clackConfirm({
    message: "This will stop and remove these containers. Continue?",
    initialValue: false,
  });

  return result !== false && result !== Symbol.for("clack:cancel");
}

async function removeContainers(
  filtered: FilteredContainers,
  runtime: RuntimeEnv,
): Promise<{ successCount: number; failCount: number }> {
  runtime.log("\nRemoving containers...\n");

  let successCount = 0;
  let failCount = 0;

  for (const container of filtered) {
    const result = await removeContainer(container.containerName, removeSandboxContainer, runtime);
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  return { successCount, failCount };
}

async function removeContainer(
  containerName: string,
  removeFn: (name: string) => Promise<void>,
  runtime: RuntimeEnv,
): Promise<{ success: boolean }> {
  try {
    await removeFn(containerName);
    runtime.log(`✓ Removed ${containerName}`);
    return { success: true };
  } catch (err) {
    runtime.error(`✗ Failed to remove ${containerName}: ${String(err)}`);
    return { success: false };
  }
}
