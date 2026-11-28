// `npm run dev` in worker/: runs `wrangler dev`, says where and as which process, and
// stops it when the terminal that started it is gone (ADR 0052).
//
// A `wrangler dev` once ran for days after its terminal had closed, orphaned to launchd,
// until it held every local port of the Mac. So this names its port and pid when it
// starts, and stops wrangler once any process that started it (npm, the shell, the
// terminal) has exited. Arguments go to wrangler as they are:
//
//   npm run dev
//   npm run dev -- --port 8787 --var DEV_FAKE_GITHUB:true

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { join } from "node:path";

/** How often it checks that whatever started it is still there. */
const CHECK_MS = 5_000;
/** How long wrangler has to stop before it is killed. */
const STOP_GRACE_MS = 5_000;

const args = process.argv.slice(2);

/** The port wrangler serves on: `--port N`, `--port=N`, or wrangler's default. */
function portOf(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--port") return argv[i + 1] ?? "8787";
    if (arg.startsWith("--port=")) return arg.slice("--port=".length);
  }
  return "8787";
}

/** The processes that started this one, nearest first, up to (not including) init or launchd. */
function ancestors(): number[] {
  const chain: number[] = [];
  for (let pid = process.ppid; pid > 1 && chain.length < 16; ) {
    chain.push(pid);
    try {
      pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    } catch {
      break;
    }
  }
  return chain;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const starters = ancestors();
// wrangler itself, not through npx, so the pid named below is the process to stop.
const wrangler: ChildProcess = spawn(join(process.cwd(), "node_modules", ".bin", "wrangler"), ["dev", ...args], {
  stdio: "inherit",
});
const port = portOf(args);
console.log(
  `dev-worker: wrangler dev on http://localhost:${port}, process ${wrangler.pid} (this script ${process.pid}). ` +
    `It stops when this terminal closes; stop it yourself with Ctrl-C or \`kill ${process.pid}\`.`,
);

let stopping = false;
function stop(why: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`dev-worker: ${why}; stopping wrangler dev (process ${wrangler.pid}).`);
  wrangler.kill("SIGTERM");
  setTimeout(() => wrangler.kill("SIGKILL"), STOP_GRACE_MS).unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => stop(`got ${signal}`));

const watch = setInterval(() => {
  const gone = starters.find((pid) => !alive(pid));
  if (gone !== undefined) stop(`process ${gone}, which started this one, has exited`);
}, CHECK_MS);

wrangler.on("exit", (code, signal) => {
  clearInterval(watch);
  process.exit(code ?? (signal === null ? 0 : 1));
});
