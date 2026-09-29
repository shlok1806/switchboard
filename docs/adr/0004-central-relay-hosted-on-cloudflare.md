# The channel and the Relay run centrally on Cloudflare

The channel and the Relay run in one hosted Cloudflare Worker, with a Durable Object per channel. We rejected running the server on one Person's laptop behind a tunnel, so the other Person doesn't depend on that laptop being awake. We also rejected a Relay on each machine: the most valuable Interrupt, two Agents on different machines touching the same file, can only be seen by a Relay that has every Agent's Claims and files in one place. Jev is available as a binding in the same Worker.
