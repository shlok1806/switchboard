# A silent socket is replaced

Status: accepted on 2026-11-06. Adds to ADR 0021 and ADR 0028. Everything else in them stands.

## Context

A Person could not see another Person's Agents on the Dashboard: the terminal said "Waiting for the wrapper's screen", and an Agent's screen and transcript reads timed out (504). The Agents were live. Their wrappers still sent heartbeats over HTTP, with fresh Context Readings, so the wrappers ran.

Only their WebSockets were dead. A socket goes half-open when a laptop sleeps or changes networks under it: no close reaches either end. The wrapper still believes it is attached. The Channel still holds the socket as open and sends that Agent's watchers, screen reads, transcript reads, Interrupts and Directives into it. A reconnect would fix it, because the Channel sends to an Agent's newest socket, but nothing triggered one. The wrapper pinged every 30 seconds and never checked for the pong. The Host's socket had the same gap.

## Decision

A wrapper's or a Host's socket that has heard nothing from the Channel for 2.5 ping intervals is given up and replaced at once.

- The Channel already answers each `ping` with a `pong` without waking from hibernation. Any frame or pong counts as hearing from it.
- The ping stays at 30 seconds, so a half-open socket is replaced within about 90 seconds. 2.5 intervals let one lost pong pass.
- The silent socket is closed and forgotten without waiting for its close event, which may never arrive. The new socket attaches again, and the Channel's newest-socket rule moves the Agent's traffic to it.
- The wrapper logs `heard nothing from the Channel for Ns; reconnecting`.
- `SWITCHBOARD_STREAM_PING_SECONDS` sets the interval, so the end-to-end test does not wait minutes.

The Channel does not yet drop a wrapper's silent socket itself. Until the wrapper reconnects, a read still waits for its timeout.
