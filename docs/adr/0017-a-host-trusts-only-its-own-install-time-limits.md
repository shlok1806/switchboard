# A Host trusts only its own install-time limits

Status: proposed on 2026-10-15. Adds to ADR 0015, which it does not change otherwise.

## Context

ADR 0015 has the Channel check every spawn against the Host's folders (`--root`) and loosest permission mode (`--max-permission-mode`). The Channel keeps those limits in its `hosts` table, and `POST /api/hosts` writes them: registering an existing Host updates its roots and mode.

Both routes take the same credential, the Person's session. Someone holding a stolen session, or the Worker itself, can therefore first widen a Host to the root `/` and `bypassPermissions`, then spawn under it. The Worker's checks only hold against honest callers. They cannot be the boundary that keeps a stolen session from starting a fully permissive Agent anywhere on the Person's machine.

## Decision

- `switchboard host run` re-checks every spawn, and every resume, against its own configuration on the machine, written at `switchboard host install` from the values the Person typed. It never trusts the Channel's copy:
  - the folder, after resolving symlinks (`realpath`), must be one of the local roots, also resolved, or under one, by path segments (so `/work2` is not under `/work`, and `..` cannot climb out);
  - the permission mode must be a known mode, no looser than the local maximum;
  - every field of the request must have the type it should. A malformed request fails that one spawn and never stops the supervisor.
- `switchboard host install` writes the local configuration from its own arguments, never from the Channel's answer.
- The Channel keeps checking too, so an honest caller hears why at once. Its checks are a convenience, not the boundary.
- Changing a Host's limits takes the machine: running `switchboard host install` again there. Nothing on the Channel can widen what a Host will run.

## Consequences

- A stolen session can start Agents on the Person's Hosts only where, and in the modes, the Person allowed on each machine. The worst it can do is what those limits allow.
- The Channel's `hosts` table can disagree with a Host. The Host's own configuration wins, and a spawn it refuses fails with the Host's reason.
- The `host_spawns` table is never pruned. It holds one short row per spawn, which is small next to the Event behind each one.
