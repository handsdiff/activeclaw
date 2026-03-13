# ActiveClaw

ActiveClaw is a stripped-down fork of OpenClaw focused on proactive agent behavior,
full memory indexing by default, and easy local customization for hosted agents.

It is currently a Node.js agent gateway focused on:

- default active / autonomous agent behavior
- full memory indexing and recall
- acting as a base repo for hosted agents that will be edited and rebuilt locally
- a long-lived gateway process
- chat-channel integrations and routing
- isolated agent sessions
- history and memory backends
- cron automation
- browser and canvas tooling
- hooks, plugins, and ACP integrations

This repository does not currently ship:

- native mobile apps
- native desktop apps
- the old bundled Control UI frontend
- Windows runtime or service support

## What It Is

ActiveClaw keeps the OpenClaw execution model, but this fork is centered on a
gateway runtime that is more active by default and assumes memory should be
indexed broadly rather than treated as an optional extra.

It is also meant to be a starting point, not a finished sealed product:
operators are expected to fork it, edit prompts, tools, channels, memory behavior,
and runtime defaults, then rebuild locally for their own hosted agents.

The package name is `activeclaw`.
The executable remains `openclaw` for compatibility.

Supported host platforms:

- macOS
- Linux

Required runtime:

- Node 22+

## Install

```bash
npm install -g activeclaw@latest
openclaw onboard --install-daemon
```

The onboarding flow configures the gateway, workspace, auth, and channels.
Daemon install uses a user service:

- `launchd` on macOS
- `systemd --user` on Linux

The CLI is the management surface for setup and operations.
It is not the defining product idea of the fork.

## Intended Use

The expected workflow is:

1. start from this repo
2. wire up the channels, agents, and memory behavior you want
3. change code and defaults freely
4. rebuild locally
5. run it as your hosted agent runtime

This fork is optimized more for that editable self-owned deployment model than
for preserving every upstream product surface.

## Common Commands

```bash
openclaw onboard
openclaw gateway run
openclaw gateway status
openclaw agent --message "Summarize the last hour"
openclaw message send --target +15555550123 --message "hello"
openclaw channels status
openclaw cron list
openclaw memory search "query"
```

## Current Architecture

At a high level:

```text
inbound channels / gateway RPC / cron / hooks
  -> routing
  -> agent + session resolution
  -> model + tools execution
  -> history / memory updates
  -> outbound channel delivery
```

The main runtime buckets are:

- `src/gateway`
  - HTTP and WebSocket control plane
  - auth, RPC methods, startup, reload, readiness
- `src/agents`
  - model execution, tool orchestration, prompt assembly, failover
- `src/channels` and channel implementations under `src/*`
  - shared channel abstractions, delivery helpers, session metadata
- `src/routing`
  - inbound route resolution to `agentId` and `sessionKey`
- `src/sessions`, `src/history`, `src/memory`
  - persistent conversation state and retrieval layers
- `src/cron`
  - scheduled agent execution and delivery
- `src/browser`, `src/canvas-host`, `src/hooks`, `src/plugins`, `src/acp`
  - optional but still in-tree runtime subsystems

## Channels

Channel support is split across built-in code and extension packages.

Current tree includes support for surfaces such as:

- Telegram
- Slack
- Discord
- Signal
- WhatsApp Web
- LINE
- IRC
- Hub
- Matrix
- Mattermost
- Feishu
- Google Chat
- Nostr
- Twitch
- Zalo

Additional channel and tool integrations live under `extensions/*`.

## Repo Layout

- `src/`
  - core runtime
- `extensions/`
  - channel and tool plugins
- `packages/`
  - auxiliary packages
- `docs/`
  - mostly upstream OpenClaw documentation
- `scripts/`
  - build, lint, release, and maintenance helpers

## Development

```bash
pnpm install
pnpm build
pnpm tsgo
pnpm test
pnpm gateway:watch
```

Notes:

- `pnpm build` builds the current CLI and gateway runtime only.
- There is no `ui:build` step anymore.
- The repository still contains internal `webchat` and `control-ui` protocol names for
  gateway compatibility, but that does not mean the old bundled UI frontend still exists.

## Upstream Relationship

ActiveClaw still tracks upstream OpenClaw selectively, but it is no longer trying to
ship the full upstream product surface.

Fork-specific direction currently includes:

- more proactive agent behavior
- automatic pre-turn memory recall
- broader default memory indexing
- a better starting point for hosted agents that will be customized in-repo
- a smaller runtime surface centered on the gateway, channels, memory, and automation

Upstream remains useful for generic concepts and for merges:

- upstream repo: `https://github.com/openclaw/openclaw`
- this fork: `https://github.com/handsdiff/activeclaw`

## Docs Status

The documentation tree and many linked docs are still largely inherited from upstream.
Some of that material still mentions removed or unsupported surfaces such as:

- Control UI
- WebChat as a user-facing bundled frontend
- native apps
- Windows support

Treat the codebase and CLI help output as the current source of truth for this fork.
