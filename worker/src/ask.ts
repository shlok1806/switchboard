// What the read-only connector's `channel` tool reads (ADR 0040): Tasks and Claims,
// Updates and Directives, Memory Notes, the Agents on the Channel, and the Claims
// gone quiet. Runs inside the Channel Durable Object and only reads.
//
// Every query goes through an index and stops at a cap, one row past it to say
// there is more. `since` trims what a newest-first read returned: Events and notes
// are stored in time order, so filtering on time in SQL would read every older row.

import type { Agent, AgentId, ChannelEvent, MemoryNote, PersonName, Task, TaskNumber } from "../../shared/src/index";
import { personFromLogin } from "../../shared/src/index";
import type { MemoryReadResult } from "./memory";
import { searchWords } from "./search-words";

/** A Claim with no Update for this many hours is Quiet, unless QUIET_CLAIM_HOURS says otherwise. */
export const DEFAULT_QUIET_CLAIM_HOURS = 4;

/** At most this many Tasks in progress. */
export const MAX_ASK_TASKS = 30;
/** At most this many Updates and Directives. */
export const MAX_ASK_SAID = 15;
/** At most this many Memory Notes. */
export const MAX_ASK_NOTES = 15;
/** At most this many Agents. */
export const MAX_ASK_AGENTS = 20;
/** How many of the newest Updates and Directives a search by words looks through. */
export const ASK_WORDS_WINDOW = 50;

/** What `about` named, once the Channel has read it. */
export type AskAbout =
  | { kind: "task"; task: TaskNumber }
  | { kind: "agent"; agent: AgentId }
  | { kind: "person"; person: PersonName }
  | { kind: "words"; words: string };

export interface ChannelQuestion {
  /** ISO 8601: leave out what is older. */
  since: string;
  about?: string;
}

/** The latest Update on a Task. */
export interface TaskUpdate {
  id: string;
  at: string;
  text: string;
  by: string;
}

export interface ChannelAnswer {
  asOf: string;
  since: string;
  about?: AskAbout;
  /** `about` named a Task the Channel does not have, or an Agent it has never seen. */
  unknown?: string;
  /** The one Task `about` named. */
  task?: Task;
  /** Tasks with a Claim (claimed or in review), newest Issue first. */
  tasks: Task[];
  tasksMore: boolean;
  /** The latest Update on each Task above that has one. */
  lastUpdates: Record<number, TaskUpdate>;
  /** Claimed Tasks with no Update for `quietAfterMs`, with when they last had one or were claimed. */
  quiet: Record<number, string>;
  quietAfterMs: number;
  /** Updates and Directives since `since`, newest first. */
  said: ChannelEvent[];
  saidMore: boolean;
  /** Why the Updates could not be read: their index is still being built. */
  saidUnavailable?: string;
  notes: MemoryNote[];
  notesMore: boolean;
  /** The Agents not Gone, most recently seen first. */
  agents: Agent[];
  agentsMore: boolean;
  /** What a search by words looked through, to say so. */
  searched?: string;
}

type EventRow = {
  seq: number;
  id: string;
  at: string;
  type: string;
  actor: string;
  capture: string | null;
  task: number | null;
  turn: string | null;
  payload: string;
};

/** What the Channel lends the reader. Every function only reads. */
export interface AskHost {
  sql: SqlStorage;
  claimedTasks(limit: number): Task[];
  task(number: TaskNumber): Task | null;
  agent(id: AgentId): Agent | null;
  liveAgents(limit: number): Agent[];
  /** Whether `name` is a Person who joined the Channel. */
  isPerson(name: PersonName): boolean;
  notes(query: { limit: number; q?: string; task?: TaskNumber; author?: AgentId }): MemoryReadResult;
  /** Whether a history index exists: built, not pending. */
  indexed(name: "events_said" | "events_directives_to"): boolean;
  toEvent(row: EventRow): ChannelEvent;
  quietAfterMs: number;
}

const AGENT_ID = /^[^/\s]+\/[^/\s]+\/[^/\s]+$/;

/** A Task number in `about`: `#12`, `12` or `task 12`. */
function taskNumber(about: string): TaskNumber | null {
  const match = /^(?:task\s*)?#?(\d{1,9})$/i.exec(about.trim());
  const n = match?.[1] === undefined ? 0 : Number(match[1]);
  return n > 0 ? n : null;
}

function holderOf(task: Task): { agent?: AgentId; person: PersonName } | null {
  const holder = task.claim?.holder;
  if (holder === undefined) return null;
  return holder.kind === "agent"
    ? { agent: holder.agentId, person: holder.agentId.split("/")[0] ?? "" }
    : { person: holder.person };
}

/** The words of `text`, lowercased, for a plain match. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/** How many of `wanted` the text has. */
function score(text: string, wanted: readonly string[]): number {
  const have = new Set(words(text));
  return wanted.filter((word) => have.has(word)).length;
}

/**
 * The items that have any of `wanted` (ADR 0043), those with more of them first and
 * otherwise in the order given.
 */
function byWords<T>(items: readonly T[], text: (item: T) => string, wanted: readonly string[]): T[] {
  return items
    .map((item) => ({ item, score: score(text(item), wanted) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((scored) => scored.item);
}

function eventText(event: ChannelEvent): string {
  const payload = event.payload as { text?: unknown; to?: unknown };
  return `${typeof payload.text === "string" ? payload.text : ""} ${typeof payload.to === "string" ? payload.to : ""}`;
}

export function askChannel(host: AskHost, question: ChannelQuestion, now = Date.now()): ChannelAnswer {
  const { sql } = host;
  const since = question.since;
  const raw = question.about?.trim() ?? "";
  const answer: ChannelAnswer = {
    asOf: new Date(now).toISOString(),
    since,
    tasks: [],
    tasksMore: false,
    lastUpdates: {},
    quiet: {},
    quietAfterMs: host.quietAfterMs,
    said: [],
    saidMore: false,
    notes: [],
    notesMore: false,
    agents: [],
    agentsMore: false,
  };

  const live = host.liveAgents(MAX_ASK_AGENTS + 1);
  let about: AskAbout | undefined;
  if (raw !== "") {
    const number = taskNumber(raw);
    const byNickname = live.find((a) => a.nickname !== undefined && a.nickname.toLowerCase() === raw.toLowerCase());
    if (number !== null) about = { kind: "task", task: number };
    else if (byNickname !== undefined) about = { kind: "agent", agent: byNickname.id };
    else if (AGENT_ID.test(raw)) about = { kind: "agent", agent: raw.toLowerCase() as AgentId };
    else {
      // A Person who joined the Channel, by their login; anything else is words to look for.
      const person = personFromLogin(raw);
      about = person !== null && host.isPerson(person) ? { kind: "person", person } : { kind: "words", words: raw };
    }
    answer.about = about;
  }

  // Tasks in progress.
  const claimed = host.claimedTasks(MAX_ASK_TASKS + 1);
  answer.tasksMore = claimed.length > MAX_ASK_TASKS;
  let tasks = claimed.slice(0, MAX_ASK_TASKS).filter((t) => t.status === "claimed" || t.status === "review");
  if (about?.kind === "task") {
    const task = host.task(about.task);
    if (task === null) answer.unknown = `The Channel has no Task #${about.task}.`;
    else answer.task = task;
    tasks = task?.claim === undefined ? [] : [task];
    answer.tasksMore = false;
  } else if (about?.kind === "agent") {
    const agent = host.agent(about.agent);
    if (agent === null) answer.unknown = `The Channel has never seen Agent ${about.agent}.`;
    tasks = tasks.filter((t) => holderOf(t)?.agent === about.agent);
  } else if (about?.kind === "person") {
    const person = about.person;
    tasks = tasks.filter((t) => holderOf(t)?.person === person);
  } else if (about?.kind === "words") {
    const wanted = searchWords(about.words);
    tasks = byWords(tasks, (t) => `${t.title} ${t.labels.join(" ")}`, wanted);
  }
  answer.tasks = tasks;

  // The latest Update on each, and whether its Claim has gone quiet.
  for (const task of tasks) {
    const row = sql
      .exec<EventRow>(
        `SELECT * FROM events INDEXED BY events_updates_by_task
         WHERE type = 'update' AND task = ? ORDER BY seq DESC LIMIT 1`,
        task.number,
      )
      .toArray()[0];
    const update = row === undefined ? undefined : host.toEvent(row);
    if (update !== undefined) {
      const actor = update.actor;
      answer.lastUpdates[task.number] = {
        id: update.id,
        at: update.at,
        text: (update.payload as { text: string }).text,
        by: actor.kind === "agent" ? actor.agentId : actor.kind === "person" ? actor.person : actor.kind,
      };
    }
    const claim = task.claim;
    if (task.status !== "claimed" || claim === undefined || claim.stale) continue;
    const last = update !== undefined && update.at > claim.claimedAt ? update.at : claim.claimedAt;
    if (now - Date.parse(last) > host.quietAfterMs) answer.quiet[task.number] = last;
  }

  // Updates and Directives.
  const said = readSaid(host, about);
  if ("unavailable" in said) answer.saidUnavailable = said.unavailable;
  else {
    let events = said.events;
    if (about?.kind === "words") {
      const wanted = searchWords(about.words);
      events = byWords(events, eventText, wanted);
      answer.searched = `the newest ${ASK_WORDS_WINDOW} Updates and Directives, the Tasks in progress and every note`;
    }
    const recent = events.filter((e) => e.at >= since);
    answer.said = recent.slice(0, MAX_ASK_SAID);
    answer.saidMore = recent.length > MAX_ASK_SAID || (said.more && recent.length === events.length);
  }

  // Memory Notes.
  if (about?.kind !== "person") {
    const query =
      about?.kind === "task"
        ? { task: about.task }
        : about?.kind === "agent"
          ? { author: about.agent }
          : about?.kind === "words"
            ? { q: about.words }
            : {};
    const read = host.notes({ limit: MAX_ASK_NOTES, ...query });
    if (read.ok) {
      // A search is best match first, so `since` does not trim it.
      const notes = about?.kind === "words" ? read.notes : read.notes.filter((n) => n.at >= since);
      answer.notes = notes;
      answer.notesMore = read.more && notes.length === read.notes.length;
    }
  }

  // The Agents on the Channel.
  let agents = live;
  if (about?.kind === "agent") {
    const agent = host.agent(about.agent);
    agents = agent === null ? [] : [agent];
  } else if (about?.kind === "person") agents = live.filter((a) => a.person === about.person);
  else if (about?.kind === "task") {
    const holder = answer.task === undefined ? null : holderOf(answer.task);
    agents = live.filter((a) => a.id === holder?.agent);
  } else if (about?.kind === "words") agents = [];
  answer.agentsMore = agents.length > MAX_ASK_AGENTS;
  answer.agents = agents.slice(0, MAX_ASK_AGENTS);
  return answer;
}

/** The newest Updates and Directives for `about`, one past the cap, through an index. */
function readSaid(
  host: AskHost,
  about: AskAbout | undefined,
): { events: ChannelEvent[]; more: boolean } | { unavailable: string } {
  const { sql } = host;
  const cap = MAX_ASK_SAID + 1;
  const read = (query: string, ...args: (string | number)[]) =>
    sql
      .exec<EventRow>(query, ...args)
      .toArray()
      .map(host.toEvent);
  let events: ChannelEvent[];
  let limit = cap;
  switch (about?.kind) {
    case "task":
      events = read(
        `SELECT * FROM events INDEXED BY events_updates_by_task
         WHERE type = 'update' AND task = ? ORDER BY seq DESC LIMIT ?`,
        about.task,
        cap,
      );
      break;
    case "agent":
    case "person": {
      const [kind, id] = about.kind === "agent" ? ["agent", about.agent] : ["person", about.person];
      events = read(
        `SELECT * FROM events INDEXED BY events_updates_by_actor
         WHERE type = 'update' AND actor_kind = ? AND actor_id = ? ORDER BY seq DESC LIMIT ?`,
        kind,
        id,
        cap,
      );
      if (about.kind === "agent" && host.indexed("events_directives_to")) {
        events.push(
          ...read(
            `SELECT * FROM events INDEXED BY events_directives_to
             WHERE type = 'directive' AND json_extract(payload, '$.to') = ? ORDER BY seq DESC LIMIT ?`,
            about.agent,
            cap,
          ),
        );
        events.sort((a, b) => b.seq - a.seq);
      }
      break;
    }
    default: {
      if (!host.indexed("events_said")) {
        return {
          unavailable:
            "Updates and Directives are not indexed on this Channel yet; it builds the index within a few days.",
        };
      }
      limit = about?.kind === "words" ? ASK_WORDS_WINDOW : cap;
      events = read(
        `SELECT * FROM events INDEXED BY events_said
         WHERE type IN ('update', 'directive') ORDER BY seq DESC LIMIT ?`,
        limit,
      );
    }
  }
  return { events, more: events.length >= limit };
}
