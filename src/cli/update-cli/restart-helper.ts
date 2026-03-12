import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_GATEWAY_PORT } from "../../config/paths.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
} from "../../daemon/constants.js";

/**
 * Shell-escape a string for embedding in single-quoted shell arguments.
 * Replaces every `'` with `'\''` (end quote, escaped quote, resume quote).
 */
function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function resolveSystemdUnit(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  if (override) {
    return override.endsWith(".service") ? override : `${override}.service`;
  }
  return `${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`;
}

function resolveLaunchdLabel(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_LAUNCHD_LABEL?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
}

/**
 * Prepares a standalone script to restart the gateway service.
 * This script is written to a temporary directory and does not depend on
 * the installed package files, ensuring restart capability even if the
 * update process temporarily removes or corrupts installation files.
 */
export async function prepareRestartScript(
  env: NodeJS.ProcessEnv = process.env,
  gatewayPort: number = DEFAULT_GATEWAY_PORT,
): Promise<string | null> {
  void gatewayPort;
  const tmpDir = os.tmpdir();
  const timestamp = Date.now();
  const platform = process.platform;

  let scriptContent = "";
  let filename = "";

  try {
    if (platform === "linux") {
      const unitName = resolveSystemdUnit(env);
      const escaped = shellEscape(unitName);
      filename = `openclaw-restart-${timestamp}.sh`;
      scriptContent = `#!/bin/sh
# Standalone restart script — survives parent process termination.
# Wait briefly to ensure file locks are released after update.
sleep 1
systemctl --user restart '${escaped}'
# Self-cleanup
rm -f "$0"
`;
    } else if (platform === "darwin") {
      const label = resolveLaunchdLabel(env);
      const escaped = shellEscape(label);
      // Fallback to 501 if getuid is not available (though it should be on macOS)
      const uid = process.getuid ? process.getuid() : 501;
      // Resolve HOME at generation time via env/process.env to match launchd.ts,
      // and shell-escape the label in the plist filename to prevent injection.
      const home = env.HOME?.trim() || process.env.HOME || os.homedir();
      const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
      const escapedPlistPath = shellEscape(plistPath);
      filename = `openclaw-restart-${timestamp}.sh`;
      scriptContent = `#!/bin/sh
# Standalone restart script — survives parent process termination.
# Wait briefly to ensure file locks are released after update.
sleep 1
# Try kickstart first (works when the service is still registered).
# If it fails (e.g. after bootout), clear any persisted disabled state,
# then re-register via bootstrap and kickstart.
if ! launchctl kickstart -k 'gui/${uid}/${escaped}' 2>/dev/null; then
  launchctl enable 'gui/${uid}/${escaped}' 2>/dev/null
  launchctl bootstrap 'gui/${uid}' '${escapedPlistPath}' 2>/dev/null
  launchctl kickstart -k 'gui/${uid}/${escaped}' 2>/dev/null || true
fi
# Self-cleanup
rm -f "$0"
`;
    } else {
      return null;
    }

    const scriptPath = path.join(tmpDir, filename);
    await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });
    return scriptPath;
  } catch {
    // If we can't write the script, we'll fall back to the standard restart method
    return null;
  }
}

/**
 * Executes the prepared restart script as a **detached** process.
 *
 * The script must outlive the CLI process because the CLI itself is part
 * of the service being restarted — `systemctl restart` / `launchctl
 * kickstart -k` will terminate the current process tree.  Using
 * `spawn({ detached: true })` + `unref()` ensures the script survives
 * the parent's exit.
 *
 * Resolves immediately after spawning; the script runs independently.
 */
export async function runRestartScript(scriptPath: string): Promise<void> {
  const child = spawn("/bin/sh", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
