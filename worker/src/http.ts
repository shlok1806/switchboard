// Small HTTP helpers shared by the Worker's route handlers.

import type { ErrorResponse } from "../../shared/src/index";

export function json<T>(body: T, status = 200): Response {
  return Response.json(body, { status });
}

export function fail(status: number, reason: string): Response {
  return json<ErrorResponse>({ ok: false, reason }, status);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
