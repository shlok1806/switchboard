import type {
  ActionResult,
  ChannelSnapshot,
  CreateTaskRequest,
  PersonAction,
  PersonName,
  StreamMessage,
  Task,
} from "@shared/index";

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
  snapshot(): Promise<ChannelSnapshot>;
  /** Follow the stream after `cursor`. Returns an unsubscribe function. */
  subscribe(
    cursor: number,
    onMessage: (message: StreamMessage) => void,
    onState: (state: ConnectionState) => void,
  ): () => void;
  act(action: PersonAction): Promise<ActionResult>;
  /** Create a Task. The Channel creates the GitHub Issue first. */
  createTask(request: CreateTaskRequest): Promise<{ ok: true; task: Task } | { ok: false; reason: string }>;
}
