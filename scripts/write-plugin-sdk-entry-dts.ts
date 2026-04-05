import fs from "node:fs";
import path from "node:path";

// `tsc` emits declarations under `dist/plugin-sdk/plugin-sdk/*` because the source lives
// at `src/plugin-sdk/*` and `rootDir` is `src/`.
//
// Our package export map points subpath `types` at `dist/plugin-sdk/<entry>.d.ts`, so we
// generate stable entry d.ts files that re-export the real declarations.
const entrypoints = [
  "index",
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
] as const;
for (const entry of entrypoints) {
  const out = path.join(process.cwd(), `dist/plugin-sdk/${entry}.d.ts`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // NodeNext: reference the runtime specifier with `.js`, TS will map it to `.d.ts`.
  fs.writeFileSync(out, `export * from "./plugin-sdk/${entry}.js";\n`, "utf8");
}
