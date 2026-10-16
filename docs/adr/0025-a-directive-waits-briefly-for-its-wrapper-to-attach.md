# A Directive waits briefly for its wrapper to attach

Status: accepted on 2026-10-16. Changes when ADR 0005's Directives fall back to Queue as `wrapper-offline`. Found while fixing a flaky e2e test (#76), built for #89.

## Context

A Directive to an Agent whose CLI can be typed into is typed right away when its wrapper's socket has attached (`interrupt.attach`), and goes to the Queue as `wrapper-offline` when it has not. Being registered does not make an Agent reachable yet: after registering, the wrapper reopens its socket with the Agent token and only then sends `interrupt.attach`. A Person who sends a Directive as soon as the Agent shows up on the Dashboard can land in that window. The Directive then waits for the Agent's next turn, which for an Agent already at work can be many minutes away. The same window opens every time the wrapper's socket reconnects after a network blip, since the wrapper attaches again on every open.

The window is milliseconds locally and a few hundred on a slow link. With a 1.5 s delay injected before the wrapper's socket reopens, a Directive sent once the Agent is Live was recorded as `queue`, `wrapper-offline`.

## Decision

The Channel holds such a Directive for a short bound and types it as soon as the wrapper attaches.

- **When it holds.** The Agent's CLI can be typed into, the Agent is not Gone, and no socket of its wrapper has attached. A Gone Agent's Directive goes to the Queue at once, as before: its wrapper is not about to attach. The hold is not limited to an Agent that registered moments ago: the reconnect after a network blip has the same window and the same fix, and a wrapper that is really offline costs only the bound before the Queue takes over.
- **How it is kept.** In a `directive_holds` table, with the time it falls back, and a `directives` deadline on the Channel's shared alarm (the earliest hold). A hold survives the Durable Object being evicted.
- **On attach.** Once the Channel has answered `interrupt.attached`, it sends every held Directive for that Agent to the wrapper, oldest first, through the same path as any Directive typed right away: the wrapper's answer settles it, and a Directive it cannot type goes to the Queue with its reason (`person-typing`, `dialog-open`, `session-not-ready`, `no-answer`). The `directive.delivery` Event records how it was delivered, as today.
- **After the bound.** A Directive still held goes to the Queue with reason `wrapper-offline`, exactly as it would have at once before: pushed to the Person's sockets, kept until acknowledged, handed over in the next register or heartbeat answer.
- **The bound** is `DIRECTIVE_ATTACH_WAIT_SECONDS`, 5 s by default: well above a slow reconnect, and short enough that a wrapper that is really offline hands over at nearly the same time as before. A held Directive is not handed over in a heartbeat answer during the hold; it is either typed or queued when the hold ends.
- A held Directive has no Event of its own. The `directive` Event is recorded when it is sent, and the one `directive.delivery` when the hold ends.

## Not changed

The Relay's Interrupts still fall back to Queue as `wrapper-offline` at once. They are the Relay's judgement that an Event is worth breaking into a turn for; a missed one rides along at the next turn, and an Interrupt held for seconds is rarely still worth typing. Only a Person's Directive, which is addressed and carries instruction weight, waits.

## Alternatives

- **Hold only for an Agent that registered within the bound.** Narrower, and needs the registration time kept per Agent. It leaves the reconnect window as it is, for no gain.
- **Have clients wait for the attach.** The e2e tests do (#76), but a Person on the Dashboard cannot see the attach, and should not have to.
- **Keep the hold in memory only**, like a Directive waiting for its wrapper's answer. Simpler, but an evicted Durable Object would lose the Directive with no `directive.delivery` at all, where today it is safely queued.
