# Relay Verdicts come from Jev, not a general LLM

The Relay makes one decision per Event per Agent, so it runs far more often than anything else in the system. That decision is a three-way choice (Drop, Queue, Interrupt), not open-ended reasoning. We use TypeSafe's Jev (`typesafe/jev` on Cloudflare Workers AI), a decision model that answers typed questions with a probability for each option. We picked it over a small general LLM such as Haiku for two reasons. It is much cheaper and faster per call. More importantly, its probabilities are calibrated, so we can require high confidence before an Interrupt and downgrade uncertain ones to Queue. As an experiment we may also log an LLM's verdict for the same inputs and compare the two.

## Amendment, 2026-10-28

The Relay still makes one decision per Event per Agent, and records each that asked Jev, fell back or was addressed as an Event of its own. A Drop by rule, which never asks Jev, is no longer one: all of one Event's rule Drops are recorded as one `verdict` Event naming the Agents, so the rows the Relay writes do not grow with the number of Agents (ADR 0030).
