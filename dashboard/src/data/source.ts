import type {
  ActionResult,
  AgentId,
  ChannelSnapshot,
  ClaimRefusal,
  CreateTaskRequest,
  HostsResponse,
  PersonAction,
  PersonName,
  SpawnAgentRequest,
  SpawnAgentResponse,
  StreamMessage,
  Task,
  TaskNumber,
} from "@shared/index";

/** A spawn answers with the Agent once it is on the Channel, or with the Host still starting it (ADR 0015). */
export type SpawnResult = { ok: true; answer: SpawnAgentResponse } | { ok: false; reason: string };

/** A Claim or release answers with the Task as it is now, or a refusal naming the holder. */
export type ClaimResult = { ok: true; task: Task } | ClaimRefusal;

export type ConnectionState = "connecting" | "live" | "reconnecting";

/**
 * What the Channel behind a source can do today. Views hide or explain the
 * parts that are not there yet instead of showing errors or made-up data.
 */
export interface Capabilities {
  /** Agents and Presence (#6). */
  agents: boolean;
  /** Relay Verdicts with Jev's probabilities (#12). */
  verdicts: boolean;
  /** Proxy and Hook Captures, so moments can be compared (#7, #15). */
  captures: boolean;
  /** Claims held by Agents or Persons (#9). */
  claims: boolean;
  /** Takeover of a Stale Claim (#11). */
  takeover: boolean;
  /** Directives from a Person to an Agent (#14). */
  directives: boolean;
  /** Changing an Agent's Proxy mode (#15). */
  proxyMode: boolean;
  /** Creating a Task, which creates the GitHub Issue (#8). */
  createTask: boolean;
}

/** The issue that will bring each missing capability, for empty states. */
export const CAPABILITY_ISSUE: Record<keyof Capabilities, number> = {
  agents: 6,
  verdicts: 12,
  captures: 7,
  claims: 9,
  takeover: 11,
  directives: 14,
  proxyMode: 15,
  createTask: 8,
};

export const ALL_CAPABILITIES: Capabilities = {
  agents: true,
  verdicts: true,
  captures: true,
  claims: true,
  takeover: true,
  directives: true,
  proxyMode: true,
  createTask: true,
};

/**
 * Everything the Dashboard needs from a Channel. The mock and the real
 * HTTP + WebSocket client both implement it, so views never know which one runs.
 */
export interface ChannelSource {
  /** The Person using this Dashboard. */
  readonly me: PersonName;
  readonly capabilities: Capabilities;
  /** True for the simulated Channel, so the UI can say it is a demo. */
  readonly isMock: boolean;
  /** The Channel now, with only its latest Events: older ones come from `olderEvents`. */
  snapshot(): Promise<ChannelSnapshot>;
  /** The page of Events before `seq`, oldest first, with `olderBefore` set when there are older ones still. */
  olderEvents(before: number): Promise<Pick<ChannelSnapshot, "events" | "verdicts" | "olderBefore">>;
  /** Follow the stream after `cursor`. Returns an unsubscribe function. */
  subscribe(
    cursor: number,
    onMessage: (message: StreamMessage) => void,
    onState: (state: ConnectionState) => void,
  ): () => void;
  act(action: PersonAction): Promise<ActionResult>;
  /** Create a Task. The Channel creates the GitHub Issue first. */
  createTask(request: CreateTaskRequest): Promise<{ ok: true; task: Task } | { ok: false; reason: string }>;
  /**
   * `POST /api/tasks/:number/claim`: claim a Task for the Person using this Dashboard (#9),
   * or, with `forAgent`, for one of that Person's own Agents.
   */
  claim(task: TaskNumber, forAgent?: AgentId): Promise<ClaimResult>;
  /** `POST /api/tasks/:number/release`: release a Claim this Person holds (#9). */
  release(task: TaskNumber): Promise<ClaimResult>;
  /** `GET /api/hosts`: the Channel's Hosts (ADR 0015), or null when its Worker has none. */
  hosts(): Promise<HostsResponse | null>;
  /** `POST /api/agents/spawn`: start an Agent on one of this Person's own Hosts. */
  spawnAgent(request: SpawnAgentRequest): Promise<SpawnResult>;
  /** `POST /api/agents/:id/stop`: ask the Host that runs one of this Person's Agents to stop it. */
  stopAgent(agent: AgentId): Promise<ActionResult>;
}
