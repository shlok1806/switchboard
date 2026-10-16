import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A unix socket's path has at most 103 bytes on macOS (104 with its NUL). The deepest the
// suite makes is a wrapper's hook socket in the e2e suite's own temp dir (`suiteTmp`).
const SOCKET_PATH_MAX = 103;
const deepest = (dir: string) => join(dir, "sb-tmp-XXXXXX", "switchboard-XXXXXX", "hook.sock");

/**
 * Runs the suite under a short temp dir under /tmp when $TMPDIR is too long for the
 * sockets its tests and wrappers listen on, and removes that dir after the run.
 */
export default function setup(): (() => void) | undefined {
  const deepPath = deepest(tmpdir());
  if (Buffer.byteLength(deepPath) <= SOCKET_PATH_MAX) return undefined;
  const short = mkdtempSync("/tmp/switchboard-test-");
  if (Buffer.byteLength(deepest(short)) > SOCKET_PATH_MAX)
    throw new Error(`no temp dir short enough for a socket: ${short}`);
  console.warn(`$TMPDIR is too long for the suite's unix sockets (${deepPath}); using ${short}`);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = short;
  return () => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    rmSync(short, { recursive: true, force: true });
  };
}
