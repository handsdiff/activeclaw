#!/usr/bin/env node

/**
 * Verifies that critical plugin-sdk exports are present in the compiled dist output.
 * Regression guard for #27569 where isDangerousNameMatchingEnabled was missing
 * from the compiled output, breaking channel extension plugins at runtime.
 *
 * Run after `pnpm build` to catch missing exports before release.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distFile = resolve(__dirname, "..", "dist", "plugin-sdk", "index.js");

if (!existsSync(distFile)) {
  console.error("ERROR: dist/plugin-sdk/index.js not found. Run `pnpm build` first.");
  process.exit(1);
}

const content = readFileSync(distFile, "utf-8");

// Extract the final export statement from the compiled output.
// tsdown/rolldown emits a single `export { ... }` at the end of the file.
const exportMatch = content.match(/export\s*\{([^}]+)\}\s*;?\s*$/);
if (!exportMatch) {
  console.error("ERROR: Could not find export statement in dist/plugin-sdk/index.js");
  process.exit(1);
}

const exportedNames = exportMatch[1]
  .split(",")
  .map((s) => {
    // Handle `foo as bar` aliases — the exported name is the `bar` part
    const parts = s.trim().split(/\s+as\s+/);
    return (parts[parts.length - 1] || "").trim();
  })
  .filter(Boolean);

const exportSet = new Set(exportedNames);

const requiredSubpathEntries = [
  "core",
  "compat",
  "telegram",
  "acpx",
  "copilot-proxy",
  "diagnostics-otel",
  "diffs",
  "google-gemini-cli-auth",
  "llm-task",
  "lobster",
  "memory-core",
  "memory-lancedb",
  "minimax-portal-auth",
  "open-prose",
  "qwen-portal-auth",
  "talk-voice",
  "test-utils",
  "thread-ownership",
  "account-id",
  "keyed-async-queue",
];

const requiredRuntimeShimEntries = ["root-alias.cjs"];

// Root plugin-sdk exports that must remain present after bundling.
// This protects the published `openclaw/plugin-sdk` entry from silently
// dropping compat or telegram helpers during build changes.
const requiredExports = [
  "DEFAULT_ACCOUNT_ID",
  "DmPolicySchema",
  "PAIRING_APPROVED_MESSAGE",
  "TelegramConfigSchema",
  "addWildcardAllowFrom",
  "applyAccountNameToChannelSection",
  "buildBaseAccountStatusSnapshot",
  "buildBaseChannelStatusSummary",
  "buildChannelConfigSchema",
  "buildTokenChannelStatusSummary",
  "clearAccountEntryFields",
  "collectAllowlistProviderGroupPolicyWarnings",
  "collectOpenGroupPolicyRouteAllowlistWarnings",
  "collectTelegramStatusIssues",
  "createLoggerBackedRuntime",
  "createNormalizedOutboundDeliverer",
  "createPluginRuntimeStore",
  "createReplyPrefixOptions",
  "createScopedAccountConfigAccessors",
  "createScopedChannelConfigBase",
  "createScopedDmSecurityResolver",
  "createScopedPairingAccess",
  "deleteAccountFromConfigSection",
  "emitInboundHistory",
  "emitOutboundHistory",
  "emptyPluginConfigSchema",
  "fetchWithSsrFGuard",
  "formatAllowFromLowercase",
  "formatDocsLink",
  "formatPairingApproveHint",
  "formatTextWithAttachmentLinks",
  "getChatChannelMeta",
  "inspectTelegramAccount",
  "isDangerousNameMatchingEnabled",
  "listTelegramAccountIds",
  "listTelegramDirectoryGroupsFromConfig",
  "listTelegramDirectoryPeersFromConfig",
  "logInboundDrop",
  "looksLikeTelegramTargetId",
  "migrateBaseNameToDefaultAccount",
  "normalizeAccountId",
  "normalizeTelegramMessagingTarget",
  "parseTelegramReplyToMessageId",
  "parseTelegramThreadId",
  "projectCredentialSnapshotFields",
  "promptAccountId",
  "readStoreAllowFromForDmPolicy",
  "requireOpenAllowFrom",
  "resolveAllowlistProviderRuntimeGroupPolicy",
  "resolveConfiguredFromCredentialStatuses",
  "resolveControlCommandGate",
  "resolveDefaultGroupPolicy",
  "resolveDefaultTelegramAccountId",
  "resolveEffectiveAllowFromLists",
  "resolveOutboundMediaUrls",
  "resolveTelegramAccount",
  "resolveTelegramGroupRequireMention",
  "resolveTelegramGroupToolPolicy",
  "sendTelegramPayloadMessages",
  "setAccountEnabledInConfigSection",
  "telegramOnboardingAdapter",
];

let missing = 0;
for (const name of requiredExports) {
  if (!exportSet.has(name)) {
    console.error(`MISSING EXPORT: ${name}`);
    missing += 1;
  }
}

for (const entry of requiredSubpathEntries) {
  const jsPath = resolve(__dirname, "..", "dist", "plugin-sdk", `${entry}.js`);
  const dtsPath = resolve(__dirname, "..", "dist", "plugin-sdk", `${entry}.d.ts`);
  if (!existsSync(jsPath)) {
    console.error(`MISSING SUBPATH JS: dist/plugin-sdk/${entry}.js`);
    missing += 1;
  }
  if (!existsSync(dtsPath)) {
    console.error(`MISSING SUBPATH DTS: dist/plugin-sdk/${entry}.d.ts`);
    missing += 1;
  }
}

for (const entry of requiredRuntimeShimEntries) {
  const shimPath = resolve(__dirname, "..", "dist", "plugin-sdk", entry);
  if (!existsSync(shimPath)) {
    console.error(`MISSING RUNTIME SHIM: dist/plugin-sdk/${entry}`);
    missing += 1;
  }
}

if (missing > 0) {
  console.error(
    `\nERROR: ${missing} required plugin-sdk artifact(s) missing (named exports or subpath files).`,
  );
  console.error("This will break channel extension plugins at runtime.");
  console.error("Check src/plugin-sdk/index.ts, subpath entries, and rebuild.");
  process.exit(1);
}

console.log(`OK: All ${requiredExports.length} required plugin-sdk exports verified.`);
