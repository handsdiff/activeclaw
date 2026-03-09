import type { Command } from "commander";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { setVerbose } from "../globals.js";
import { backfillAgentHistory, type HistoryBackfillSummary } from "../history/backfill.js";
import { getMemorySearchManager } from "../memory/index.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { withManager } from "./cli-utils.js";
import { resolveCommandSecretRefsViaGateway } from "./command-secret-gateway.js";
import { getMemoryCommandSecretTargetIds } from "./command-secret-targets.js";
import { formatHelpExamples } from "./help-format.js";

type HistoryBackfillCliOptions = {
  agent?: string;
  reindex?: boolean;
  json?: boolean;
  verbose?: boolean;
  hubJson?: boolean;
};

async function loadHistoryCommandConfig(commandName: string) {
  const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config: loadConfig(),
    commandName,
    targetIds: getMemoryCommandSecretTargetIds(),
  });
  return { config: resolvedConfig, diagnostics };
}

function emitDiagnostics(diagnostics: string[], json: boolean): void {
  if (diagnostics.length === 0) {
    return;
  }
  for (const entry of diagnostics) {
    const message = theme.warn(`[secrets] ${entry}`);
    if (json) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(message);
    }
  }
}

async function reindexHistory(
  agentId: string,
  cfg: ReturnType<typeof loadConfig>,
): Promise<string | null> {
  let result: string | null = null;
  await withManager({
    getManager: () => getMemorySearchManager({ cfg, agentId }),
    onMissing: (error) => {
      result = error ?? "Memory search disabled; skipped reindex.";
    },
    close: async (manager) => {
      await manager.close?.();
    },
    onCloseError: (err) => {
      defaultRuntime.error(`Memory manager close failed: ${String(err)}`);
    },
    run: async (manager) => {
      const sync = manager.sync?.bind(manager);
      if (!sync) {
        result = "Memory backend does not support manual reindex; skipped reindex.";
        return;
      }
      await sync({ reason: "cli", force: true });
      result = null;
    },
  });
  return result;
}

function formatSummary(summary: HistoryBackfillSummary, reindexStatus?: string | null): string {
  const lines = [
    `History backfill (${summary.agentId})`,
    `Existing history records: ${summary.existingHistoryRecords}`,
    `Session transcripts: ${summary.sessionFilesImported}/${summary.sessionFilesScanned} imported`,
    `Hub JSON files: ${summary.hubJsonFilesImported}/${summary.hubJsonFilesScanned} imported`,
    `Channel records written: ${summary.channelRecordsWritten}`,
    `Cron records written: ${summary.cronRecordsWritten}`,
    `Duplicate records skipped: ${summary.duplicateRecordsSkipped}`,
    `Filtered records skipped: ${summary.filteredRecordsSkipped}`,
  ];
  if (reindexStatus) {
    lines.push(`Reindex: ${reindexStatus}`);
  }
  return lines.join("\n");
}

export function registerHistoryCli(program: Command) {
  const history = program
    .command("history")
    .description("Manage the durable searchable history corpus")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw history backfill --agent main --reindex",
            "Import surviving local transcripts into history and reindex.",
          ],
          ["openclaw history backfill --json", "Print a machine-readable import summary."],
          [
            "openclaw history backfill --no-hub-json",
            "Import transcripts only and skip Hub JSON supplements.",
          ],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/history", "docs.openclaw.ai/cli/history")}\n`,
    );

  history
    .command("backfill")
    .description("Backfill durable history from surviving local transcripts and run logs")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--reindex", "Force a memory reindex after import", false)
    .option("--json", "Print JSON summary", false)
    .option("--verbose", "Verbose logging", false)
    .option("--no-hub-json", "Skip supplemental Hub JSON import")
    .action(async (opts: HistoryBackfillCliOptions) => {
      setVerbose(Boolean(opts.verbose));
      const { config: cfg, diagnostics } = await loadHistoryCommandConfig("history backfill");
      emitDiagnostics(diagnostics, Boolean(opts.json));
      const agentId = opts.agent?.trim() || resolveDefaultAgentId(cfg);
      const summary = await backfillAgentHistory({
        cfg,
        agentId,
        includeHubJson: opts.hubJson !== false,
      });
      let reindexStatus: string | null = null;
      if (opts.reindex) {
        const result = await reindexHistory(agentId, cfg);
        reindexStatus = result ?? "completed";
      }

      if (opts.json) {
        defaultRuntime.log(
          JSON.stringify(
            {
              ...summary,
              reindexStatus,
            },
            null,
            2,
          ),
        );
        return;
      }
      defaultRuntime.log(formatSummary(summary, reindexStatus));
    });
}
