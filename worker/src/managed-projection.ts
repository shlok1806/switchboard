import type { Actor, Agent, AgentId, ChannelEvent, Person, Task } from "../../shared/src/domain";
import type { SafeAgent } from "../../shared/src/m1";
import type { MemoryNote } from "../../shared/src/memory";

/** Call only after current enrollment and agent.view authorization. */
export function safeAgent(
  agent: Agent,
  identity: Pick<SafeAgent, "principalId" | "executionId" | "ownerPersonId">,
): SafeAgent {
  return {
    id: agent.id,
    principalId: identity.principalId,
    executionId: identity.executionId,
    ownerPersonId: identity.ownerPersonId,
    cli: agent.cli,
    presence: agent.presence,
    startedAt: agent.startedAt,
    lastSeenAt: agent.lastSeenAt,
  };
}

/** Membership and workspace.read must be checked by the caller before projection. */
export function safePerson(person: Person): Person {
  return { name: person.name, timeZone: person.timeZone, joinedAt: person.joinedAt };
}

function safeActor(actor: Actor): Actor | null {
  switch (actor.kind) {
    case "agent":
      return { kind: "agent", agentId: actor.agentId };
    case "person":
      return { kind: "person", person: actor.person };
    case "github":
      return { kind: "github" };
    case "relay":
      return { kind: "relay" };
    default:
      return null;
  }
}

/**
 * Shared query preparation only; never grants admission. The caller must check
 * history + constituent/author authority and revalidate before release. Unknown,
 * private and directed payloads default to omission. No capture/session metadata.
 */
export function safeSharedEvent(event: ChannelEvent) {
  const actor = safeActor(event.actor);
  if (!actor) return null;
  const base = { id: event.id, seq: event.seq, at: event.at, actor };
  switch (event.type) {
    case "update":
      if (event.payload.to?.length) return null;
      return { ...base, type: "update" as const, payload: { text: event.payload.text } };
    case "presence":
      return { ...base, type: "presence" as const, payload: { presence: event.payload.presence } };
    default:
      return null;
  }
}

/** Native attribution is supplied only after current authority admits the target. */
export type SafeAttribution = { kind: "agent"; agentId: AgentId } | { kind: "person"; personId: string };
export interface SafeTask {
  number: number;
  title: string;
  description: string;
  labels: string[];
  blockedBy: number[];
  parent?: number;
  subtasks: number[];
  subtasksDone: number;
  steps: { index: number; text: string; done: boolean }[];
  stepsDone: number;
  url: string;
  status: Task["status"];
  claim?: { task: number; holder: SafeAttribution; claimedAt: string; stale: boolean; blockedBy?: number[] };
  branch?: string;
  pr?: number;
  updatedAt: string;
}
export interface SafeMemoryNote {
  seq: number;
  id: string;
  at: string;
  author: SafeAttribution;
  task?: number;
  tags: MemoryNote["tags"];
  text: string;
  files?: string[];
}
function attribution(value: SafeAttribution): SafeAttribution {
  return value.kind === "agent"
    ? { kind: "agent", agentId: value.agentId }
    : { kind: "person", personId: value.personId };
}
/** Caller admits the Task, its referenced Tasks and its holder before construction. */
export function safeTask(task: Task, holder?: SafeAttribution): SafeTask | null {
  if (task.claim && (!holder || task.claim.task !== task.number)) return null;
  return {
    number: task.number,
    title: task.title,
    description: task.description,
    labels: [...task.labels],
    blockedBy: [...task.blockedBy],
    ...(task.parent === undefined ? {} : { parent: task.parent }),
    subtasks: [...task.subtasks],
    subtasksDone: task.subtasksDone,
    steps: task.steps.map((step) => ({ index: step.index, text: step.text, done: step.done })),
    stepsDone: task.stepsDone,
    url: task.url,
    status: task.status,
    ...(task.claim && holder
      ? {
          claim: {
            task: task.claim.task,
            holder: attribution(holder),
            claimedAt: task.claim.claimedAt,
            stale: task.claim.stale,
            ...(task.claim.blockedBy === undefined ? {} : { blockedBy: [...task.claim.blockedBy] }),
          },
        }
      : {}),
    ...(task.branch === undefined ? {} : { branch: task.branch }),
    ...(task.pr === undefined ? {} : { pr: task.pr }),
    updatedAt: task.updatedAt,
  };
}
/** Never derive a native Person from MemoryNote.person or the AgentId prefix. */
export function safeMemoryNote(note: MemoryNote, author: SafeAttribution): SafeMemoryNote {
  return {
    seq: note.seq,
    id: note.id,
    at: note.at,
    author: attribution(author),
    ...(note.task === undefined ? {} : { task: note.task }),
    tags: [...note.tags],
    text: note.text,
    ...(note.files === undefined ? {} : { files: [...note.files] }),
  };
}
