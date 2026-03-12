---
summary: "Remote access using SSH tunnels (Gateway WS) and tailnets"
read_when:
  - Running or troubleshooting remote gateway setups
title: "Remote Access"
---

# Remote access (SSH, tunnels, and tailnets)

This repo supports “remote over SSH” by keeping a single Gateway (the master) running on a dedicated host (desktop/server) and connecting clients to it.

- SSH tunneling is the universal fallback when the Gateway stays loopback-only.

## The core idea

- The Gateway WebSocket binds to **loopback** on your configured port (defaults to 18789).
- For remote use, you forward that loopback port over SSH (or use a tailnet/VPN and tunnel less).

## Common VPN/tailnet setups (where the agent lives)

Think of the **Gateway host** as “where the agent lives.” It owns sessions, auth profiles, channels, and state.
Your laptop/desktop connect to that host.

### 1) Always-on Gateway in your tailnet (VPS or home server)

Run the Gateway on a persistent host and reach it via **Tailscale** or SSH.

- **Best UX:** keep `gateway.bind: "loopback"` and use **Tailscale Serve** for the Control UI.
- **Fallback:** keep loopback + SSH tunnel from any machine that needs access.
- **Examples:** [exe.dev](/install/exe-dev) (easy VM) or [Hetzner](/install/hetzner) (production VPS).

This is ideal when your laptop sleeps often but you want the agent always-on.

### 2) Home desktop runs the Gateway, laptop is remote control

The laptop does **not** run the agent. It connects remotely:

- Use an SSH tunnel and point the CLI or Control UI at `ws://127.0.0.1:<forwarded-port>`.

### 3) Laptop runs the Gateway, remote access from other machines

Keep the Gateway local but expose it safely:

- SSH tunnel to the laptop from other machines, or
- Tailscale Serve the Control UI and keep the Gateway loopback-only.

Guide: [Tailscale](/gateway/tailscale) and [Web overview](/web).

## Command flow (what runs where)

One gateway service owns state, channels, sessions, and tool execution.

Flow example (Telegram -> gateway):

- Telegram message arrives at the **Gateway**.
- Gateway runs the **agent**.
- Gateway executes any permitted local tools.
- Gateway replies back out to Telegram.

## SSH tunnel (CLI + tools)

Create a local tunnel to the remote Gateway WS:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

With the tunnel up:

- `openclaw health` and `openclaw status --deep` now reach the remote gateway via `ws://127.0.0.1:18789`.
- `openclaw gateway {status,health,send,agent,call}` can also target the forwarded URL via `--url` when needed.

Note: replace `18789` with your configured `gateway.port` (or `--port`/`OPENCLAW_GATEWAY_PORT`).
Note: when you pass `--url`, the CLI does not fall back to config or environment credentials.
Include `--token` or `--password` explicitly. Missing explicit credentials is an error.

## CLI remote defaults

You can persist a remote target so CLI commands use it by default:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

When the gateway is loopback-only, keep the URL at `ws://127.0.0.1:18789` and open the SSH tunnel first.

## Credential precedence

Gateway credential resolution follows one shared contract across call/probe/status paths and Discord exec-approval monitoring:

- Explicit credentials (`--token`, `--password`, or tool `gatewayToken`) always win on call paths that accept explicit auth.
- URL override safety:
  - CLI URL overrides (`--url`) never reuse implicit config/env credentials.
  - Env URL overrides (`OPENCLAW_GATEWAY_URL`) may use env credentials only (`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`).
- Local mode defaults:
  - token: `OPENCLAW_GATEWAY_TOKEN` -> `gateway.auth.token` -> `gateway.remote.token` (remote fallback applies only when local auth token input is unset)
  - password: `OPENCLAW_GATEWAY_PASSWORD` -> `gateway.auth.password` -> `gateway.remote.password` (remote fallback applies only when local auth password input is unset)
- Remote mode defaults:
  - token: `gateway.remote.token` -> `OPENCLAW_GATEWAY_TOKEN` -> `gateway.auth.token`
  - password: `OPENCLAW_GATEWAY_PASSWORD` -> `gateway.remote.password` -> `gateway.auth.password`
- Remote probe/status token checks are strict by default: they use `gateway.remote.token` only (no local token fallback) when targeting remote mode.
- Legacy `CLAWDBOT_GATEWAY_*` env vars are only used by compatibility call paths; probe/status/auth resolution uses `OPENCLAW_GATEWAY_*` only.

## Chat UI over SSH

WebChat no longer uses a separate HTTP port. The browser UI connects directly to the Gateway WebSocket.

- Forward `18789` over SSH (see above), then connect clients to `ws://127.0.0.1:18789`.
- Keep the tunnel lifecycle explicit so operators can see exactly which host/port is exposed.

## Security rules (remote/VPN)

Short version: **keep the Gateway loopback-only** unless you’re sure you need a bind.

- **Loopback + SSH/Tailscale Serve** is the safest default (no public exposure).
- Plaintext `ws://` is loopback-only by default. For trusted private networks,
  set `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` on the client process as break-glass.
- **Non-loopback binds** (`lan`/`tailnet`/`custom`, or `auto` when loopback is unavailable) must use auth tokens/passwords.
- `gateway.remote.token` / `.password` are client credential sources. They do **not** configure server auth by themselves.
- Local call paths can use `gateway.remote.*` as fallback only when `gateway.auth.*` is unset.
- If `gateway.auth.token` / `gateway.auth.password` is explicitly configured via SecretRef and unresolved, resolution fails closed (no remote fallback masking).
- `gateway.remote.tlsFingerprint` pins the remote TLS cert when using `wss://`.
- **Tailscale Serve** can authenticate Control UI/WebSocket traffic via identity
  headers when `gateway.auth.allowTailscale: true`; HTTP API endpoints still
  require token/password auth. This tokenless flow assumes the gateway host is
  trusted. Set it to `false` if you want tokens/passwords everywhere.
- Treat browser control like operator access: tailnet-only and explicitly authenticated.

Deep dive: [Security](/gateway/security).
