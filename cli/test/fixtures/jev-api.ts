// A stand-in for TypeSafe's Jev API, for the end-to-end test: the Worker running
// in `wrangler dev` points JEV_API_URL here. It answers the verdict question with
// set probabilities and records every request, so the test can check the state the
// Relay sent.

import { createServer, type Server } from "node:http";
import type { RelayState, VerdictOption, VerdictProbabilities } from "../../../shared/src/index";

export interface JevRequest {
  authorization: string | undefined;
  model: string;
  state: RelayState;
  questions: Record<string, unknown>;
}

export class JevApi {
  readonly requests: JevRequest[] = [];
  answer: VerdictProbabilities = { drop: 0.05, queue: 0.8, interrupt: 0.15 };
  private server: Server | null = null;

  async start(port: number): Promise<string> {
    this.server = createServer((request, response) => {
      let text = "";
      request.on("data", (chunk) => {
        text += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(text) as Omit<JevRequest, "authorization">;
        this.requests.push({ authorization: request.headers.authorization, ...body });
        const p = this.answer;
        const choice = (Object.keys(p) as VerdictOption[]).reduce((a, b) => (p[b] > p[a] ? b : a));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: "jev-stand-in",
            answers: { verdict: { type: "choice", choice, confidence: p[choice], probabilities: p } },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(port, "127.0.0.1", resolve));
    return `http://127.0.0.1:${port}/v1/systemone`;
  }

  stop(): void {
    this.server?.close();
  }
}
