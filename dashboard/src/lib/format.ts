import type {
  Actor,
  Capture,
  ChannelEvent,
  Cli,
  Holder,
  Presence,
  TaskField,
  TaskSyncVia,
  VerdictOption,
} from "@shared/index";

export const CLI_LABEL: Record<Cli, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};

export const PRESENCE_LABEL: Record<Presence, string> = { live: "Live", idle: "Idle", gone: "Gone" };

export const CAPTURE_LABEL: Record<Capture, string> = { proxy: "Proxy", hook: "Hook", tool: "Tool" };

export const VERDICT_LABEL: Record<VerdictOption, string> = {
  drop: "Drop",
  queue: "Queue",
  interrupt: "Interrupt",
};

export const VERDICT_OPTIONS: VerdictOption[] = ["drop", "queue", "interrupt"];

export function actorName(actor: Actor): string {
  if (actor.kind === "agent") return actor.agentId;
  if (actor.kind === "person") return actor.person;
  return "GitHub";
}

export function holderName(holder: Holder): string {
  return holder.kind === "agent" ? holder.agentId : holder.person;
}

/** The Person behind an Actor, or null for GitHub. */
export function actorPerson(actor: Actor): string | null {
  if (actor.kind === "agent") return actor.agentId.split("/")[0];
  if (actor.kind === "person") return actor.person;
  return null;
}

/** Where an Event came from when it has no Agent Capture. */
export function captureOrOrigin(e: ChannelEvent): string {
  if (e.capture) return CAPTURE_LABEL[e.capture];
  // Task sync Events say how they arrived: the Channel API, a webhook or a reconcile.
  if ("via" in e.payload) return SYNC_VIA_LABEL[e.payload.via];
  if (e.actor.kind === "person") return "Dashboard";
  if (e.actor.kind === "github" || e.type === "push" || e.type === "merge") return "GitHub";
  // Recorded by the Channel itself, such as an Agent going Gone after silence.
  return "Channel";
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always", style: "narrow" });

/** "12s ago", "4m ago", "2h ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 5) return "now";
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const pct = (p: number) => `${Math.round(p * 100)}%`;
export const prob = (p: number) => p.toFixed(2);

export function compact(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** A one-line human summary of an Event, used in feeds and timelines. */
export function summarize(e: ChannelEvent): string {
  switch (e.type) {
    case "session.start":
      return e.payload.resumed ? "Resumed session" : "Started session";
    case "session.end":
      return e.payload.reason === "timeout" ? "Session timed out" : "Session ended";
    case "presence":
      return `Presence is now ${PRESENCE_LABEL[e.payload.presence]}`;
    case "tool.call":
      return `${e.payload.tool} ${e.payload.arg}`;
    case "file.edit":
      return `Edited ${e.payload.path}`;
    case "command":
      return `$ ${e.payload.command}`;
    case "turn.end":
      return `Turn ${e.payload.turn} ended`;
    case "proxy.digest":
      return e.payload.reply;
    case "proxy.raw":
      return e.payload.reply;
    case "claim":
      return "Claimed";
    case "claim.refused":
      return `Claim refused, held by ${holderName(e.payload.heldBy)}`;
    case "claim.release":
      return "Released the Claim";
    case "step.complete":
      return `Step ${e.payload.step} done: ${e.payload.text}`;
    case "update":
      return e.payload.text;
    case "directive":
      return e.payload.text;
    case "takeover":
      return `Took over from ${holderName(e.payload.from)} for ${holderName(e.payload.to)}`;
    case "push":
      return e.payload.commits.length > 1
        ? `Pushed ${e.payload.commits.length} commits to ${e.payload.branch}: ${e.payload.message}`
        : `Pushed ${e.payload.commit.slice(0, 7)} to ${e.payload.branch}: ${e.payload.message}`;
    case "merge":
      return `Merged #${e.payload.pr} (${e.payload.branch}) into ${e.payload.into}`;
    case "task.branch":
      return `Working on branch ${e.payload.branch}`;
    case "task.review":
      return `Finished, pull request #${e.payload.pr} is open for review`;
    case "task.done":
      return e.payload.closedOnGitHub ? "Issue closed on GitHub, Task done" : "Task done";
    case "person.join":
      return `Joined the Channel (${e.payload.timeZone})`;
    case "task.create":
      return e.payload.via === "channel" ? `Created Task: ${e.payload.title}` : `New Task from GitHub: ${e.payload.title}`;
    case "task.change":
      return `Changed on GitHub: ${e.payload.fields.map((f) => TASK_FIELD_LABEL[f]).join(", ")}`;
    case "task.reopen":
      return "Issue reopened on GitHub";
    case "task.remove":
      return "Issue deleted or moved on GitHub, Task removed";
    case "mirror.failed":
      return `Could not mirror the ${e.payload.change} to GitHub (${e.payload.call}): ${e.payload.reason}`;
  }
}

export const TASK_FIELD_LABEL: Record<TaskField, string> = {
  title: "title",
  description: "description",
  labels: "labels",
  blockedBy: "blockers",
  parent: "parent",
  subtasks: "Subtasks",
  steps: "Steps",
};

export const SYNC_VIA_LABEL: Record<TaskSyncVia, string> = {
  channel: "Dashboard",
  webhook: "GitHub webhook",
  reconcile: "GitHub reconcile",
};

export const EVENT_TYPE_LABEL: Record<ChannelEvent["type"], string> = {
  "session.start": "Session",
  "session.end": "Session",
  presence: "Presence",
  "tool.call": "Tool call",
  "file.edit": "File edit",
  command: "Command",
  "turn.end": "Turn end",
  "proxy.digest": "Proxy Digest",
  "proxy.raw": "Raw Proxy Event",
  claim: "Claim",
  "claim.refused": "Claim refused",
  "claim.release": "Release",
  "step.complete": "Step",
  update: "Update",
  directive: "Directive",
  takeover: "Takeover",
  push: "Push",
  merge: "Merge",
  "task.branch": "Branch",
  "task.review": "In review",
  "task.done": "Done",
  "person.join": "Joined",
  "task.create": "New Task",
  "task.change": "Task changed",
  "task.reopen": "Reopened",
  "task.remove": "Task removed",
  "mirror.failed": "GitHub mirror failed",
};
