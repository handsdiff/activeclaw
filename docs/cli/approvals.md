---
summary: "CLI reference for `openclaw approvals` (exec approvals for the local host or gateway)"
read_when:
  - You want to edit exec approvals from the CLI
  - You need to manage allowlists on the local host or gateway
title: "approvals"
---

# `openclaw approvals`

Manage exec approvals for the **local host** or **gateway host**.
By default, commands target the local approvals file on disk. Use `--gateway` to target the gateway.

Related:

- Exec approvals: [Exec approvals](/tools/exec-approvals)

## Common commands

```bash
openclaw approvals get
openclaw approvals get --gateway
```

## Replace approvals from a file

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Allowlist helpers

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Notes

- `--agent` defaults to `"*"`, which applies to all agents.
- Approvals files are stored per host at `~/.openclaw/exec-approvals.json`.
