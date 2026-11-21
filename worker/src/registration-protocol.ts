import type { PersonActor } from "../../shared/src/m1";
import type { MutationPermit } from "./policy-permits";
import type { IntentPayload, IntentState } from "./registration-intents";
import type { RegistrationReservation } from "./registration-reservations";

/** Internal bound-Channel protocol. No correlation identifier is a bearer credential. */
export interface RegistrationPreparation {
  actor: PersonActor;
  principalId: string;
  workspaceId: string;
  channelId: string;
  generation: number;
  agentId: string;
  hostId: string | null;
  requestId: string;
  request: string;
  credentialExpiresAt: number;
}
export interface PreparedRegistration {
  reservation: RegistrationReservation;
  permits: [MutationPermit, MutationPermit];
}
export interface RegistrationProof {
  payload: IntentPayload;
  state: IntentState;
}
