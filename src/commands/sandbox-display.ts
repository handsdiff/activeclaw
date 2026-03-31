/**
 * Display utilities for sandbox CLI
 */

import type { SandboxContainerInfo } from "../agents/sandbox.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import type { RuntimeEnv } from "../runtime.js";
import { formatImageMatch, formatSimpleStatus, formatStatus } from "./sandbox-formatters.js";

type DisplayConfig<T> = {
  emptyMessage: string;
  title: string;
  renderItem: (item: T, runtime: RuntimeEnv) => void;
};

function displayItems<T>(items: T[], config: DisplayConfig<T>, runtime: RuntimeEnv): void {
  if (items.length === 0) {
    runtime.log(config.emptyMessage);
    return;
  }

  runtime.log(`\n${config.title}\n`);
  for (const item of items) {
    config.renderItem(item, runtime);
  }
}

export function displayContainers(containers: SandboxContainerInfo[], runtime: RuntimeEnv): void {
  displayItems(
    containers,
    {
      emptyMessage: "No sandbox containers found.",
      title: "📦 Sandbox Containers:",
      renderItem: (container, rt) => {
        rt.log(`  ${container.containerName}`);
        rt.log(`    Status:  ${formatStatus(container.running)}`);
        rt.log(`    Image:   ${container.image} ${formatImageMatch(container.imageMatch)}`);
        rt.log(
          `    Age:     ${formatDurationCompact(Date.now() - container.createdAtMs, { spaced: true }) ?? "0s"}`,
        );
        rt.log(
          `    Idle:    ${formatDurationCompact(Date.now() - container.lastUsedAtMs, { spaced: true }) ?? "0s"}`,
        );
        rt.log(`    Session: ${container.sessionKey}`);
        rt.log("");
      },
    },
    runtime,
  );
}

export function displaySummary(containers: SandboxContainerInfo[], runtime: RuntimeEnv): void {
  const totalCount = containers.length;
  const runningCount = containers.filter((container) => container.running).length;
  const mismatchCount = containers.filter((container) => !container.imageMatch).length;

  runtime.log(`Total: ${totalCount} (${runningCount} running)`);

  if (mismatchCount > 0) {
    runtime.log(`\n⚠️  ${mismatchCount} container(s) with image mismatch detected.`);
    runtime.log(
      `   Run '${formatCliCommand("openclaw sandbox recreate --all")}' to update all containers.`,
    );
  }
}

export function displayRecreatePreview(
  containers: SandboxContainerInfo[],
  runtime: RuntimeEnv,
): void {
  runtime.log("\nContainers to be recreated:\n");

  if (containers.length > 0) {
    runtime.log("📦 Sandbox Containers:");
    for (const container of containers) {
      runtime.log(`  - ${container.containerName} (${formatSimpleStatus(container.running)})`);
    }
  }

  runtime.log(`\nTotal: ${containers.length} container(s)`);
}

export function displayRecreateResult(
  result: { successCount: number; failCount: number },
  runtime: RuntimeEnv,
): void {
  runtime.log(`\nDone: ${result.successCount} removed, ${result.failCount} failed`);

  if (result.successCount > 0) {
    runtime.log("\nContainers will be automatically recreated when the agent is next used.");
  }
}
