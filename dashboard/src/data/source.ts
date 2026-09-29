import type {
  ActionResult,
  ChannelSnapshot,
  PersonAction,
  PersonName,
  StreamMessage,
} from "@shared/index";

export type ConnectionState = "connecting" | "live" | "reconnecting";

/**
 * Everything the Dashboard needs from a Channel. The mock and the real
 * HTTP + WebSocket client both implement it, so views never know which one runs.
 */
export interface ChannelSource {
  /** The Person using this Dashboard. */
  readonly me: PersonName;
  snapshot(): Promise<ChannelSnapshot>;
  /** Follow the stream after `cursor`. Returns an unsubscribe function. */
  subscribe(
    cursor: number,
    onMessage: (message: StreamMessage) => void,
    onState: (state: ConnectionState) => void,
  ): () => void;
  act(action: PersonAction): Promise<ActionResult>;
}
