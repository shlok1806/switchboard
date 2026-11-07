# A shared skill leaves out its installed packages

Status: accepted on 2026-11-07, for the owner's direction to make web-designer shareable too. Amends ADR 0050 (a shared skill holds any files, up to 64 MB) on what a publish reads from the skill's directory. Everything else in ADR 0050 stands.

## Context

After ADR 0050, every one of the owner's skills published except two. One of them, web-designer, was refused because `node_modules/.bin/playwright-core` is a symbolic link, and a shared skill holds plain files only. That `node_modules` is not the skill's own work: it is what npm installed from the skill's `package.json` and `package-lock.json` (playwright-core, about 15 MB), and the skill's own `scripts/doctor.mjs --fix` installs it again on a machine that lacks it. npm puts links in `node_modules/.bin` on every install, so any skill with a dependency hits the same refusal.

Shipping installed packages would also be wrong if they were plain files: they are built for the publisher's platform, they are most of the bytes, and git, npm and every packager leave them out for the same reason.

## Decision

- A publish leaves out every directory named `node_modules`, at any depth in the skill, with everything in it, links included. The rest of the skill is read and checked as before: a link anywhere else is still refused.
- The same read gives the files an install compares and replaces, so an install leaves a `node_modules` already in the installed skill alone; it is not in the diff and it is not removed.
- A skill that needs its packages says how to get them, as web-designer does. The Person who installs it runs that, or `npm ci` in the skill's directory.

## Consequences

- A skill with npm dependencies can be shared, and its shared copy holds only what its author wrote plus the manifest npm rebuilds from.
- A skill whose author committed hand-written files under a `node_modules` directory loses them on publish. None of the owner's 79 skills does, and that is not where a person keeps their own files.

## Verification

- `cli/test/e2e.test.ts`, the publish test: a skill with a `package.json` and an installed `node_modules`, including a `.bin` link, publishes, and its shared files are the skill's own without anything from `node_modules`.
