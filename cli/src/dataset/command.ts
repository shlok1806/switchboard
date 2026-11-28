// `switchboard dataset sync|stats` (ADR 0054), and the background sync a wrapper starts
// when its session's turn or session ends.

import { spawn } from "node:child_process";
import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readConfig } from "../config";
import { channelEvents, ghPullRequests, gitRepoOf, greenroomRunsDir, type LinkDeps } from "./outcomes";
import { datasetDir, sourcesPath } from "./sources";
import { keptSessions, syncDataset } from "./sync";

export const DATASET_USAGE = `Usage:
  switchboard dataset sync [--relink] [--offline] [--quiet]
  switchboard dataset stats [--json]`;

/** What linking reaches on this machine: git, gh and the Channel, unless offline. */
async function linkDeps(dir: string, offline: boolean, env: NodeJS.ProcessEnv): Promise<LinkDeps> {
  const base: LinkDeps = { greenroomRuns: greenroomRunsDir(env), repoOf: gitRepoOf() };
  if (offline) return base;
  let config = null;
  try {
    config = await readConfig(env);
  } catch {
    // An old config: link without the Channel.
  }
  return {
    ...base,
    pullRequests: ghPullRequests(join(dir, "cache")),
    ...(config === null ? {} : { agentEvents: channelEvents(config), person: config.person }),
  };
}

async function sync(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { relink: { type: "boolean" }, offline: { type: "boolean" }, quiet: { type: "boolean" } },
  });
  const dir = datasetDir(env);
  const say = values.quiet ? () => {} : (line: string) => console.log(line);
  const started = Date.now();
  const report = await syncDataset({
    dir,
    env,
    link: await linkDeps(dir, values.offline === true, env),
    ...(values.relink ? { relink: true } : {}),
    say,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!report.ran) {
    say("Another dataset sync is running; this one did nothing.");
    return 0;
  }
  const skipped = Object.entries(report.skipped);
  const lines = [
    `Synced ${dir} in ${seconds}s: ${report.scanned} sessions read, ${report.written} written, ${report.relinked} linked again, ${report.unchanged} unchanged.`,
    ...(skipped.length === 0
      ? []
      : [
          `Skipped, account not in ${sourcesPath(dir)}: ${skipped.map(([account, n]) => `${n} of ${account}`).join(", ")}.`,
        ]),
    ...(report.removed === 0 ? [] : [`Removed ${report.removed} sessions whose account is no longer listed.`]),
    ...report.failed.map((f) => `Could not sync ${f.session}: ${f.error}`),
  ];
  for (const line of lines) say(line);
  // The background sync has no terminal: its last run is kept in the Dataset's log.
  await appendFile(join(dir, "sync.log"), `${new Date().toISOString()} ${lines.join(" ")}\n`, { mode: 0o600 }).catch(
    () => {},
  );
  return report.failed.length === 0 ? 0 : 1;
}

/** What `dataset stats` counts. */
export interface DatasetStats {
  sessions: Record<string, number>;
  threads: { subagents: number; workflowAgents: number; workflowRuns: number };
  turns: number;
  prompts: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheCreation: number; cacheRead: number };
  corrections: Record<string, number>;
  outcomes: {
    linked: number;
    withRepo: number;
    withCommits: number;
    withPrs: number;
    prs: Record<string, number>;
    reverted: number;
    withSwitchboardTask: number;
    withGreenroomRun: number;
    greenroomVerdicts: Record<string, number>;
    unlinked: Record<string, number>;
  };
  redactions: Record<string, number>;
}

export async function datasetStats(dir: string): Promise<DatasetStats> {
  const stats: DatasetStats = {
    sessions: {},
    threads: { subagents: 0, workflowAgents: 0, workflowRuns: 0 },
    turns: 0,
    prompts: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    corrections: {},
    outcomes: {
      linked: 0,
      withRepo: 0,
      withCommits: 0,
      withPrs: 0,
      prs: {},
      reverted: 0,
      withSwitchboardTask: 0,
      withGreenroomRun: 0,
      greenroomVerdicts: {},
      unlinked: {},
    },
    redactions: {},
  };
  const add = (map: Record<string, number>, key: string, n = 1) => {
    map[key] = (map[key] ?? 0) + n;
  };
  for await (const { session, outcome } of keptSessions(dir)) {
    add(stats.sessions, session.cli);
    for (const thread of session.threads) {
      if (thread.kind === "subagent") stats.threads.subagents++;
      if (thread.kind === "workflow-agent") stats.threads.workflowAgents++;
    }
    stats.threads.workflowRuns += session.workflows.length;
    stats.turns += session.counts.turns;
    stats.prompts += session.counts.prompts;
    stats.toolCalls += session.counts.toolCalls;
    for (const key of ["input", "output", "cacheCreation", "cacheRead"] as const)
      stats.tokens[key] += session.tokens[key];
    for (const [kind, n] of Object.entries(session.correctionKinds ?? {})) add(stats.corrections, kind, n);
    for (const [kind, n] of Object.entries(session.redactions)) add(stats.redactions, kind, n);
    if (outcome === null) continue;
    const o = stats.outcomes;
    o.linked++;
    if (outcome.repo !== undefined) o.withRepo++;
    if (outcome.commits.length > 0) o.withCommits++;
    if (outcome.prs.length > 0) o.withPrs++;
    for (const pr of outcome.prs) {
      add(o.prs, pr.state ?? "unknown");
      if (pr.revertedBy !== undefined) o.reverted++;
    }
    if ((outcome.switchboard?.tasks.length ?? 0) > 0) o.withSwitchboardTask++;
    if (outcome.greenroom.length > 0) o.withGreenroomRun++;
    for (const run of outcome.greenroom) add(o.greenroomVerdicts, run.verdict ?? run.outcome ?? "none");
    for (const gap of outcome.unlinked)
      add(
        o.unlinked,
        `${gap.what.split(" ")[0]}: ${gap.why.replace(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|\d{8}-\d{6}-[0-9a-f]{16}/g, "…")}`,
      );
  }
  return stats;
}

function printStats(dir: string, s: DatasetStats): void {
  const n = (value: number) => value.toLocaleString("en-US");
  const pairs = (map: Record<string, number>) =>
    Object.entries(map)
      .sort(([, a], [, b]) => b - a)
      .map(([key, value]) => `${key} ${n(value)}`)
      .join(", ") || "none";
  const total = Object.values(s.sessions).reduce((a, b) => a + b, 0);
  console.log(`Dataset at ${dir}`);
  console.log(`Sessions: ${n(total)} (${pairs(s.sessions)})`);
  console.log(
    `Threads: ${n(s.threads.subagents)} subagents, ${n(s.threads.workflowRuns)} workflow runs with ${n(s.threads.workflowAgents)} agents`,
  );
  console.log(`Turns: ${n(s.turns)}, of them ${n(s.prompts)} typed prompts; ${n(s.toolCalls)} tool calls`);
  console.log(
    `Tokens: ${n(s.tokens.input)} input, ${n(s.tokens.output)} output, ${n(s.tokens.cacheRead)} cache read, ${n(s.tokens.cacheCreation)} cache written`,
  );
  console.log(`Corrections: ${pairs(s.corrections)}`);
  const o = s.outcomes;
  console.log(
    `Outcomes linked: ${n(o.linked)} sessions; ${n(o.withRepo)} with a repo, ${n(o.withCommits)} with commits, ${n(o.withPrs)} with pull requests (${pairs(o.prs)}; ${n(o.reverted)} reverted)`,
  );
  console.log(
    `  ${n(o.withSwitchboardTask)} with a Switchboard Task, ${n(o.withGreenroomRun)} with Greenroom runs (${pairs(o.greenroomVerdicts)})`,
  );
  console.log(`Not linked: ${pairs(o.unlinked)}`);
  console.log(`Redacted: ${pairs(s.redactions)}`);
}

async function stats(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
  const dir = datasetDir(env);
  const s = await datasetStats(dir);
  if (values.json) console.log(JSON.stringify(s, null, 2));
  else printStats(dir, s);
  return 0;
}

export async function datasetCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === "sync") return sync(rest, env);
  if (verb === "stats") return stats(rest, env);
  console.error(DATASET_USAGE);
  return 2;
}

/** How often a wrapper starts a background sync at a turn's end. */
const TURN_SYNC_MS = 10 * 60_000;

/**
 * Starts `switchboard dataset sync --quiet` in the background, detached, so a turn or a
 * session never waits on it and nothing it does can fail them. Only once the owner has
 * set the Dataset up (`sources.json` exists, from their first sync), and never with
 * `SWITCHBOARD_DATASET=off`. At most once per TURN_SYNC_MS for turn ends; a session's
 * end always starts one. A second sync while one runs does nothing (the lock).
 */
export class DatasetTrigger {
  private last = 0;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly entry: string | undefined = process.argv[1],
  ) {}

  async kick(reason: "turn" | "end", now = Date.now()): Promise<boolean> {
    if (this.env.SWITCHBOARD_DATASET === "off" || this.entry === undefined) return false;
    if (reason === "turn" && now - this.last < TURN_SYNC_MS) return false;
    try {
      await stat(sourcesPath(datasetDir(this.env)));
    } catch {
      return false;
    }
    this.last = now;
    try {
      const child = spawn(process.execPath, [this.entry, "dataset", "sync", "--quiet"], {
        detached: true,
        stdio: "ignore",
        env: this.env,
      });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
}
