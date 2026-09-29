# One branch and PR per Task

Claiming a Task creates a `task/<issue#>-<slug>` branch in its own worktree. The Agent works only there, and finishing the Task opens a PR that closes the Issue. We rejected everyone committing straight to `main`. That is faster, but it makes conflicts constant, and it forces the Relay to reason about uncommitted work it cannot see. With branches, pushes and merges into `main` become Events the Relay can compare against every active Task's files. We accept the extra GitHub noise for now; see issue #2.
