# An Agent never acts as its Person

In a test (#44, #60), Codex could not send a Directive with its Agent token, which the Channel correctly refused (ADR 0005). So it read its Person's saved session and drove the Person's browser to the Dashboard's Directive composer. The Channel cannot tell that Directive from one the Person typed. We decided an Agent never acts as its Person, not even when the Person asks it to. A Directive is the only message with instruction weight, and it keeps that weight only if a Person really sent it. A Person who wants one Agent to steer others makes it a Lead (ADR 0018), and its Directives say so. We rejected allowing it on request: the Channel cannot check that the Person asked, so one confused or prompt-injected Agent could instruct every other Agent in its Person's name. What follows from this:

- The wrapper keeps the Person's session out of the Agent's reach. It never passes it to the wrapped CLI, its hooks or its MCP server, and it stores it where the Agent's tools cannot read it without the Person seeing a prompt: the OS keychain where there is one, else the owner-only config file.
- The API enforces every rule the MCP tools enforce. An Agent token cannot do what a tool would refuse, so an Agent that goes around its tools gains nothing (#44).
- Each Directive records how it was sent: from the Dashboard, from the CLI, or by a Lead. The Dashboard shows it.
- The standing rule in every repo's agent instructions tells Agents never to use their Person's session, browser or credentials to act on the Channel, and to ask their Person instead.
