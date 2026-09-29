# Stale Claims never expire on their own

When an Agent goes Gone, its Claim becomes Stale but stays held until a Person does a Takeover from the Dashboard. Agents cannot take Claims from each other. We rejected expiring claims after a timeout: it keeps work moving without humans, but half-finished work can still be sitting uncommitted on the Gone Agent's machine. A second agent restarting that work from scratch is exactly the duplicate effort Switchboard exists to prevent.
