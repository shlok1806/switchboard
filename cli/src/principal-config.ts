// Managed enrollment is separate from legacy login and never persists credentials.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { AgentExecution } from "../../shared/src/m1";

export interface PrincipalSelection {
  principalId: string;
  workspaceId: string;
}

export function principalSelection(principalId: string, workspaceId: string): PrincipalSelection {
  const id = /^[0-9a-f-]{36}:[0-9a-f-]{36}$/;
  if (!id.test(principalId) || !id.test(workspaceId) || principalId.split(":")[0] !== workspaceId.split(":")[0]) {
    throw new Error("Select a principal and Workspace in the same Organization.");
  }
  return { principalId, workspaceId };
}

async function post(origin: string, path: string, body: unknown, session?: string): Promise<Response> {
  try {
    return await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Managed authentication could not reach Switchboard.");
  }
}

/** A fresh native device login; no legacy session exchange, Channel join or config write. */
export async function authenticateNative(origin: string, say: (line: string) => void): Promise<string> {
  const response = await post(origin, "/auth/device/code?destination=native", {});
  if (!response.ok) throw new Error("Native sign-in is unavailable.");
  const device = (await response.json().catch(() => {
    throw new Error("Invalid sign-in response.");
  })) as {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    interval: number;
    expiresIn: number;
  };
  if (
    typeof device.deviceCode !== "string" ||
    typeof device.userCode !== "string" ||
    typeof device.verificationUri !== "string" ||
    !Number.isFinite(device.interval) ||
    !Number.isFinite(device.expiresIn) ||
    device.expiresIn <= 0
  )
    throw new Error("Invalid sign-in response.");
  say(`Sign in at ${device.verificationUri} with code ${device.userCode}.`);
  const deadline = Date.now() + Math.min(device.expiresIn, 900) * 1000;
  let interval = Math.max(1, Math.min(device.interval, 30)) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const poll = await post(origin, "/auth/device/token", { deviceCode: device.deviceCode, destination: "native" });
    if (!poll.ok) throw new Error("Native sign-in failed.");
    const answer = (await poll.json().catch(() => {
      throw new Error("Invalid sign-in response.");
    })) as { ok: boolean; destination?: string; session?: string; slowDown?: boolean };
    if (answer.ok) {
      if (answer.destination !== "native" || typeof answer.session !== "string")
        throw new Error("Native sign-in required.");
      return answer.session;
    }
    if (answer.slowDown) interval += 5000;
  }
  throw new Error("Native sign-in expired.");
}

/** Raw TTY input deliberately never echoes the redemption code or puts it in argv. */
export function readRedemptionCode(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) return Promise.reject(new Error("Redemption requires an interactive terminal."));
  process.stderr.write("Execution redemption code: ");
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    let code = "";
    const finish = (error?: Error) => {
      input.off("data", data);
      input.off("error", failed);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(code);
    };
    const failed = () => finish(new Error("Could not read redemption code."));
    const data = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") {
          finish(new Error("Redemption cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") code = code.slice(0, -1);
        else if (/^[A-Za-z0-9_-]$/.test(char) && code.length < 256) code += char;
      }
    };
    input.setRawMode(true);
    input.on("data", data);
    input.once("error", failed);
    input.resume();
  });
}

/** Expiry requires a new server-issued execution/code, not a retry of the old code. */
export async function readFreshExecutionId(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Redemption requires an interactive terminal.");
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await reader.question("Fresh execution ID: ")).trim();
  } finally {
    reader.close();
  }
}

/** Two attempts maximum, only matching expired codes retry. All errors are redacted. */
export async function redeemExecution(options: {
  origin: string;
  selection: PrincipalSelection;
  executionId: string;
  authenticate: () => Promise<string>;
  readCode: () => Promise<string>;
  refreshExecution: () => Promise<string>;
}): Promise<{ execution: AgentExecution; credential: string }> {
  const origin = new URL(options.origin);
  if (
    origin.origin !== options.origin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "localhost"))
  ) {
    throw new Error("Use a Switchboard origin.");
  }
  const selection = principalSelection(options.selection.principalId, options.selection.workspaceId);
  let executionId = options.executionId;
  const validExecution = (id: string) =>
    /^[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(id) && id.split(":")[0] === selection.workspaceId.split(":")[0];
  if (
    !/^[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(options.executionId) ||
    options.executionId.split(":")[0] !== selection.workspaceId.split(":")[0]
  )
    throw new Error("Invalid execution selection.");
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await options.authenticate();
    const code = await options.readCode();
    const response = await post(
      origin.origin,
      `/api/m1/executions/${encodeURIComponent(executionId)}/redemption`,
      { code },
      session,
    );
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string };
      value?: { execution?: AgentExecution; secret?: string };
    } | null;
    if (response.status === 410 && body?.error?.code === "CODE_EXPIRED") {
      if (attempt === 0) {
        const fresh = await options.refreshExecution();
        if (!validExecution(fresh) || fresh === executionId) throw new Error("A fresh execution is required.");
        executionId = fresh;
      }
      continue;
    }
    if (!response.ok) throw new Error("Execution redemption denied.");
    const execution = body?.value?.execution;
    const credential = body?.value?.secret;
    if (
      !execution ||
      execution.id !== executionId ||
      execution.principalId !== selection.principalId ||
      execution.workspaceId !== selection.workspaceId ||
      typeof credential !== "string" ||
      !credential.startsWith(`m1.${selection.workspaceId.split(":")[0]}.`) ||
      !/^m1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(credential)
    )
      throw new Error("Invalid execution response.");
    return { execution, credential };
  }
  throw new Error("Execution redemption expired; request a fresh code.");
}
