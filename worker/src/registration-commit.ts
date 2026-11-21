import { AuthorityUnavailable, LocalMutationPermits, type MutationPermit, type PermitBinding } from "./policy-permits";
import type { IntentPayload, StoredIntent } from "./registration-intents";
import { RegistrationIntents } from "./registration-intents";

/** Request-local external effects only. SQL/presence/claim callbacks must never
 * be queued here. This is neither a durable journal nor an authorization cache.
 */
export class RegistrationEffects {
  private callbacks: (() => void)[] = [];
  private state: "collecting" | "discarded" | "released" = "collecting";

  defer(callback: () => void): void {
    if (this.state !== "collecting") throw new Error("registration_effects_closed");
    this.callbacks.push(callback);
  }
  discard(): void {
    this.state = "discarded";
    this.callbacks = [];
  }
  /** Synchronous fence immediately before EACH external effect. Never retry
   * registration to replay a notification. A failed callback cannot roll back
   * an already committed SQL transaction; report it separately to the caller.
   */
  release(current: () => boolean): unknown[] {
    if (this.state !== "collecting") return [];
    this.state = "released";
    const callbacks = this.callbacks;
    this.callbacks = [];
    const errors: unknown[] = [];
    for (const callback of callbacks) {
      try {
        if (!current()) break;
      } catch (error) {
        errors.push(error);
        break;
      }
      try {
        callback();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
}

export interface RegistrationCommit<T, Checkpoint> {
  storage: DurableObjectStorage;
  intentId: string;
  /** Fresh authority result, not the original START/HAND receipts. */
  permit: MutationPermit;
  /** Independently reconstructed from live local state after the last await. */
  binding: PermitBinding;
  /** Synchronous checks of binding/generation, activation correlation, actor,
   * predecessor, Host and existing registration prerequisites. No external I/O.
   */
  current(intent: IntentPayload): boolean;
  /** Include lastSeq and any transaction-local in-memory cache in this checkpoint. */
  checkpoint(): Checkpoint;
  restore(checkpoint: Checkpoint): void;
  /** Run the synchronous EXISTING registration algorithm on live state. Required
   * business refusal must throw, so resume/queue deletions also roll back.
   * Nested sends/Relay/watch/Host waiter effects use the supplied collector.
   */
  register(intent: IntentPayload, effects: RegistrationEffects): T;
}

/** Preserve an existing business refusal for the route to serialize AFTER rollback. */
export class RegistrationRefused extends Error {
  constructor(readonly result: { ok: false; status: number; reason: string }) {
    super(result.reason);
  }
}

/** TXN-2 local commit primitive, NOT an RPC/admission boundary. Its caller must
 * have confirmed Organization activation and obtained a NEW decide-backed
 * apply permit. No shared state may be changed before this invocation.
 */
export function commitRegistration<T, Checkpoint>(
  input: RegistrationCommit<T, Checkpoint>,
): { value: T; intent: StoredIntent; effects: RegistrationEffects } {
  const effects = new RegistrationEffects();
  const checkpoint = input.checkpoint();
  try {
    return input.storage.transactionSync(() => {
      // One sampled commit time; no await anywhere in this synchronous closure.
      const now = Date.now();
      const intents = new RegistrationIntents(input.storage.sql);
      const intent = intents.get(input.intentId);
      if (intent?.state !== "activated" || now >= intent.payload.expiresAt || !input.current(intent.payload))
        throw new AuthorityUnavailable();
      const payload = intent.payload;
      const binding = input.binding;
      if (
        input.permit.id === payload.startPermitId ||
        input.permit.id === payload.handoffPermitId ||
        binding.action !== "agent.execution.start" ||
        binding.actor.kind !== "person" ||
        binding.actor.personId !== payload.actorPersonId ||
        binding.actor.githubId !== payload.actorGithubId ||
        binding.requestId !== payload.requestId ||
        binding.generation !== payload.bindingGeneration ||
        binding.policyRevision < payload.policyRevision ||
        binding.resource.kind !== "workspace" ||
        binding.resource.id !== payload.workspaceId ||
        binding.resource.organizationId !== payload.organizationId ||
        binding.resource.channel !== payload.channelId ||
        binding.resource.targetId !== payload.agentId ||
        binding.resource.ownerPersonId !== payload.ownerPersonId ||
        (binding.resource.hostId ?? null) !== payload.hostId ||
        binding.resource.operation !== `agent.register.apply:${payload.intentId}`
      )
        throw new AuthorityUnavailable();
      const permits = new LocalMutationPermits(input.storage.sql);
      if (!permits.consumedByIntent([payload.startPermitId, payload.handoffPermitId], payload.intentId, now))
        throw new AuthorityUnavailable();
      permits.observeRevision(payload.workspaceId, binding.policyRevision);
      permits.install(input.permit);
      if (!permits.consume(input.permit.id, binding, now)) throw new AuthorityUnavailable();
      const value = input.register(payload, effects);
      // A Promise here would move effects outside SQLite's rollback boundary.
      if (value && typeof value === "object" && "then" in value) throw new Error("registration_must_be_synchronous");
      if (value && typeof value === "object" && "ok" in value && value.ok === false) {
        if (
          !("status" in value) ||
          typeof value.status !== "number" ||
          !("reason" in value) ||
          typeof value.reason !== "string"
        )
          throw new Error("invalid_registration_refusal");
        throw new RegistrationRefused({ ok: false, status: value.status, reason: value.reason });
      }
      const applied = intents.transition(payload.intentId, "activated", "applied", now);
      return { value, intent: applied, effects };
    });
  } catch (error) {
    effects.discard();
    input.restore(checkpoint);
    throw error;
  }
}
