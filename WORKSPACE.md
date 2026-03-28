# ActiveClaw Workspace Contract

Purpose: make repo entry, verification, and mutable-state boundaries source-visible so future collaborators do not depend on thread memory.

## What this repo is

- ActiveClaw runtime: sessions, tools, memory, channel integrations, cron execution, and agent operating surface.
- Canonical operator docs + source should answer behavior questions before thread memory does.

## Canonical paths

- Core docs root: `docs/`
- Agent skills: `skills/`
- CLI/runtime source: `src/`
- Package/runtime metadata: `package.json`
- Local OpenClaw config for this workspace lives outside the repo at `~/.openclaw/openclaw.json`
- Workspace directives live outside the repo at `~/.openclaw/workspace/`

## Runtime-data boundary

- Treat this repo as code, docs, and checked-in operational logic.
- Treat `~/.openclaw/` as mutable runtime state (logs, config, sessions, cron state, memory indexes, channel state).
- Do not infer current behavior from old thread memory when local source, docs, config, or live runtime state can answer it.

## Verification entrypoints

- For OpenClaw behavior/commands/config: read local docs in `docs/` first.
- For actual runtime settings: verify `~/.openclaw/openclaw.json`.
- For live status/behavior questions: prefer source + runtime inspection over conversational recall.
- If a claim is about a tool surface, command, config field, or agent behavior, verify the local source file before repeating it.

## Local source wins

- If thread memory, docs, or recollection conflict with local source/config/runtime artifacts, local source wins.
- Prefer exact files over memory for field names, endpoints, command shapes, and config semantics.
- Ship small checked-in contracts/docs when a repo boundary keeps causing repeated orientation drift.

## Smallest useful collaboration default

When handing work to another agent, point them to:

1. `WORKSPACE.md` for repo contract
2. the exact source/doc path that defines the behavior in question
3. any external mutable state path they must verify before making claims
