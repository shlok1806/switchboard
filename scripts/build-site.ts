// Builds the static site the Worker serves at `/` into worker/site/.
//
// wrangler runs this before `wrangler dev` and `wrangler deploy` (the `build` block
// in worker/wrangler.jsonc). It builds the Dashboard (dashboard/) and copies its
// output into worker/site/. If the Dashboard cannot be built, it copies the
// stopgap page in worker/public/ instead, so the Worker always serves something.
//
//   tsx ../scripts/build-site.ts            build the Dashboard, fall back if it fails
//   tsx ../scripts/build-site.ts --fallback  skip the Dashboard and copy the stopgap

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dashboard = join(root, "dashboard");
const dashboardDist = join(dashboard, "dist");
const stopgap = join(root, "worker", "public");
const site = join(root, "worker", "site");

function npm(args: string[]): void {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: dashboard, stdio: "inherit" });
}

function buildDashboard(): boolean {
  try {
    if (!existsSync(join(dashboard, "node_modules"))) npm(["ci"]);
    npm(["run", "build"]);
    return existsSync(join(dashboardDist, "index.html"));
  } catch (error) {
    console.warn(`build-site: the Dashboard did not build (${error instanceof Error ? error.message : error}).`);
    return false;
  }
}

function publish(from: string, label: string): void {
  rmSync(site, { recursive: true, force: true });
  mkdirSync(site, { recursive: true });
  cpSync(from, site, { recursive: true });
  console.log(`build-site: serving ${label} from worker/site/.`);
}

const fallbackOnly = process.argv.includes("--fallback");
if (!fallbackOnly && buildDashboard()) {
  publish(dashboardDist, "the Dashboard");
} else {
  publish(stopgap, "the stopgap page (worker/public)");
}
