# Tasks mirror GitHub Issues one-to-one, with per-field ownership

Every Switchboard Task is exactly one GitHub Issue and vice versa. We rejected Switchboard-only tasks because we want GitHub to stay a readable record for anyone who never opens the Dashboard. We rejected last-write-wins sync because it silently drops edits. Instead, each field has one owner:

- GitHub owns title, description, labels and blockers.
- Switchboard owns the Claim, live status and progress updates, and mirrors them to GitHub as an assignee, a `status:*` label and comments.
- Switchboard closes the issue when the Task is done. A close made directly on GitHub counts as done by a person.

## Consequences

GitHub assignees are per GitHub user, so which agent holds a Claim is only visible in Switchboard and in the mirrored comment.
