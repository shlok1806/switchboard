# One bad Channel cannot take the machine down

Status: accepted on 2026-11-07. Adds to ADR 0048. Everything else in it stands.

## Context

On 2026-11-07 every new connection on the owner's Mac failed with `EADDRNOTAVAIL`: all 16,384 ephemeral ports were in use. About 16,300 loopback connections were held by a `wrangler dev` (its node process and its workerd) that a Person had started with `npm run dev` 2.6 days before and forgotten, orphaned to launchd. Several Switchboard wrappers used it as their Channel. Near the end their logs showed a heartbeat timing out every 10 to 30 seconds, and the Claude sessions' own API requests failing.

Reproduced against `wrangler dev` 4.143.1 (workerd 1.20260926.1, Node 26.8.2), three things were found.

1. **A close nobody answers keeps the connection.** A client that closed its socket without a code (`ws.close()`, as the wrapper, the Host and the Dashboard all did) sends a close frame with no status. The Channel answered every close by echoing the client's code, and 1005 ("no code") may not be sent, so `ws.close(1005)` threw, was caught as "already closed", and the close was never answered. Node's WebSocket waits for that answer without a deadline, so the connection stayed open on both ends for as long as the client process lived. Through `wrangler dev`, 20 such closes left 20 connections in the client, 41 in wrangler's proxy workerd and 20 in the Worker's workerd, for minutes, until the client exited. Answered, the same 20 closes leave none.
2. **A silent socket was replaced at a fixed pace, and not closed.** ADR 0048 replaces a socket that hears nothing for 2.5 pings at once. Against a Channel that accepts sockets and then says nothing, a wrapper opened a new socket every 2.5 pings and, because of 1, kept every old one: 2 connections became 9 in 20 seconds. A socket whose handshake never got an answer had no deadline at all, so the wrapper sat without a socket for good.
3. **A wedged `wrangler dev` answers nothing.** While a rebuild has failed (a syntax error in a file it watches), wrangler's proxy queues every request and answers none, until a later rebuild succeeds. Heartbeats then time out every 10 seconds, the log pattern from the incident. Upstream behaviour, recorded here; Switchboard cannot change it, only survive it.

Aborted HTTP requests did not leak: Node's fetch destroys the connection of a request it aborts, and wrangler closed its side within seconds.

## Decision

Every Switchboard client survives a Channel that stops answering without adding to the damage, and the Channel answers every close.

- **The Channel answers every close.** It echoes the client's code when an endpoint may send it, and answers 1000 otherwise (1004, 1005, 1006, 1015).
- **Every socket the CLI opens has deadlines and is closed for real.** The wrapper and the Host use the `ws` package (MIT), whose `terminate()` destroys a connection, instead of Node's WebSocket, which cannot. A socket that has not opened within 2.5 pings is given up. A socket replaced for silence is destroyed at once. Any other close sends 1000 and destroys the connection if the Channel has not answered within 3 seconds.
- **Retries back off, with jitter.** A socket's n-th failure in a row waits a random time between half and all of 1 s × 2^n, at most 30 s (a minute for the Host). A socket counts as working only once the Channel has answered one of its pings, so one that opens and goes silent does not reset the backoff. A heartbeat that cannot reach the Channel waits the same way, from one heartbeat interval up to ten (5 minutes); beats in between are skipped. The wrapper logs `cannot reach the Channel` once, and `reached the Channel again` when it does. The agent CLI's session never waits on any of it.
- **HTTP calls are bounded.** One process has at most 4 requests to the Channel in flight; the rest wait their turn, within their own deadline. Each response body is read, so its connection returns to fetch's keep-alive pool.
- **Running out of ports or descriptors is named.** `EADDRNOTAVAIL`, `EMFILE`, `ENFILE` and `ENOBUFS`, from a request, a socket or the model proxy, are reported as "this machine has run out of local ports; something is holding thousands of connections", with the `lsof` line that names the holder. The client then opens no new connection to the Channel for a minute, and its heartbeats and socket wait the longest backoff.
- **`npm run dev` cannot run forever unnoticed.** In `worker/` it runs `scripts/dev-worker.ts`, which prints wrangler's port and pid, and stops wrangler once any process that started it (npm, the shell, the terminal) has exited.
- **A local Channel is said out loud.** A wrapper whose Worker is on this machine (`localhost`, `127.*`, `[::1]`) says so on its terminal at start: it is a developer's `wrangler dev`, not the shared Channel.

## Consequences

- The CLI gains one runtime dependency, `ws`.
- A Channel that recovers is reached again within the longest backoff: 30 seconds for a socket, 5 minutes for heartbeats. An Agent whose heartbeats back off past the Channel's Gone threshold (10 minutes) is not marked Gone by the backoff alone.
- The upstream behaviours stay: wrangler's proxy queues requests without a deadline while a rebuild has failed, and Node's WebSocket waits without a deadline for a close to be answered.
