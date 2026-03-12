import { resolveGatewayLogPaths } from "./launchd.js";
import { toPosixPath } from "./output.js";

function toDarwinDisplayPath(value: string): string {
  return toPosixPath(value).replace(/^[A-Za-z]:/, "");
}

export function buildPlatformRuntimeLogHints(params: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  systemdServiceName: string;
}): string[] {
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  if (platform === "darwin") {
    const logs = resolveGatewayLogPaths(env);
    return [
      `Launchd stdout (if installed): ${toDarwinDisplayPath(logs.stdoutPath)}`,
      `Launchd stderr (if installed): ${toDarwinDisplayPath(logs.stderrPath)}`,
    ];
  }
  if (platform === "linux") {
    return [`Logs: journalctl --user -u ${params.systemdServiceName}.service -n 200 --no-pager`];
  }
  return [];
}

export function buildPlatformServiceStartHints(params: {
  platform?: NodeJS.Platform;
  installCommand: string;
  startCommand: string;
  launchAgentPlistPath: string;
  systemdServiceName: string;
}): string[] {
  const platform = params.platform ?? process.platform;
  const base = [params.installCommand, params.startCommand];
  switch (platform) {
    case "darwin":
      return [...base, `launchctl bootstrap gui/$UID ${params.launchAgentPlistPath}`];
    case "linux":
      return [...base, `systemctl --user start ${params.systemdServiceName}.service`];
    default:
      return base;
  }
}
