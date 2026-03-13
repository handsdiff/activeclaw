#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const buildArgs = ["exec", "tsdown", "--config-loader", "unrun", "--logLevel", logLevel];

let result = spawnSync("pnpm", buildArgs, {
  stdio: "inherit",
});

if (result.error?.code === "ENOENT") {
  result = spawnSync("corepack", ["pnpm", ...buildArgs], {
    stdio: "inherit",
  });
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
