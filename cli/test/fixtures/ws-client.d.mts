export interface WsClient {
  /** Whether the server agreed to permessage-deflate. */
  deflate: boolean;
  /** Every text message the server sent, in order. */
  messages: string[];
  onMessage?: (text: string) => void;
  closed: Promise<void>;
  send(text: string): Promise<void>;
  close(): void;
}

export function connect(url: string, headers?: Record<string, string>): Promise<WsClient>;
