import fs from "node:fs/promises";

export type PermissionCheck = {
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  bits: number | null;
  source: "posix" | "unknown";
  worldWritable: boolean;
  groupWritable: boolean;
  worldReadable: boolean;
  groupReadable: boolean;
  error?: string;
};

export type PermissionCheckOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

export async function safeStat(targetPath: string): Promise<{
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  error?: string;
}> {
  try {
    const lst = await fs.lstat(targetPath);
    return {
      ok: true,
      isSymlink: lst.isSymbolicLink(),
      isDir: lst.isDirectory(),
      mode: typeof lst.mode === "number" ? lst.mode : null,
      uid: typeof lst.uid === "number" ? lst.uid : null,
      gid: typeof lst.gid === "number" ? lst.gid : null,
    };
  } catch (err) {
    return {
      ok: false,
      isSymlink: false,
      isDir: false,
      mode: null,
      uid: null,
      gid: null,
      error: String(err),
    };
  }
}

export async function inspectPathPermissions(
  targetPath: string,
  opts?: PermissionCheckOptions,
): Promise<PermissionCheck> {
  const st = await safeStat(targetPath);
  if (!st.ok) {
    return {
      ok: false,
      isSymlink: false,
      isDir: false,
      mode: null,
      bits: null,
      source: "unknown",
      worldWritable: false,
      groupWritable: false,
      worldReadable: false,
      groupReadable: false,
      error: st.error,
    };
  }

  let effectiveMode = st.mode;
  let effectiveIsDir = st.isDir;
  if (st.isSymlink) {
    try {
      const target = await fs.stat(targetPath);
      effectiveMode = typeof target.mode === "number" ? target.mode : st.mode;
      effectiveIsDir = target.isDirectory();
    } catch {
      // Keep lstat-derived metadata when target lookup fails.
    }
  }

  const bits = modeBits(effectiveMode);
  void opts;
  return {
    ok: true,
    isSymlink: st.isSymlink,
    isDir: effectiveIsDir,
    mode: effectiveMode,
    bits,
    source: "posix",
    worldWritable: isWorldWritable(bits),
    groupWritable: isGroupWritable(bits),
    worldReadable: isWorldReadable(bits),
    groupReadable: isGroupReadable(bits),
  };
}

export function formatPermissionDetail(targetPath: string, perms: PermissionCheck): string {
  return `${targetPath} mode=${formatOctal(perms.bits)}`;
}

export function formatPermissionRemediation(params: {
  targetPath: string;
  perms: PermissionCheck;
  isDir: boolean;
  posixMode: number;
  env?: NodeJS.ProcessEnv;
}): string {
  const mode = params.posixMode.toString(8).padStart(3, "0");
  return `chmod ${mode} ${params.targetPath}`;
}

export function modeBits(mode: number | null): number | null {
  if (mode == null) {
    return null;
  }
  return mode & 0o777;
}

export function formatOctal(bits: number | null): string {
  if (bits == null) {
    return "unknown";
  }
  return bits.toString(8).padStart(3, "0");
}

export function isWorldWritable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o002) !== 0;
}

export function isGroupWritable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o020) !== 0;
}

export function isWorldReadable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o004) !== 0;
}

export function isGroupReadable(bits: number | null): boolean {
  if (bits == null) {
    return false;
  }
  return (bits & 0o040) !== 0;
}
