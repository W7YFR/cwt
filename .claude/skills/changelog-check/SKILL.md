---
name: changelog-check
description: Check that the CHANGELOG.md entry for the current branch is accurate, complete and brief against the branch's diff from main. Use when the user says "check the changelog", "is the changelog right", "/changelog-check".
---

# Check the changelog entry

Verify this branch's `CHANGELOG.md` entry against what the branch changes.
The rules for an entry are in `CLAUDE.md` under "Changelog". Read them
first.

## 1. Find the entry

- Run `git log --format=%s main..HEAD`. A `chore: release vX.Y.Z` subject means
  the bump ran, and the entry is `node scripts/changelog.mjs X.Y.Z`.
- Otherwise the entry is `node scripts/changelog.mjs --unreleased`.
- Other branches may have merged pending lines under `## Unreleased`. Compare
  with `git show $(git merge-base HEAD main):CHANGELOG.md`, and check only the
  lines this branch added.
- Run `node scripts/version.mjs --ships`. If it prints `false`, the branch
  releases nothing. Its lines must all be under `### Development`.

## 2. Read the change

- `git diff main...HEAD -- app/src app/public app/index.html` for what users get.
- `git diff main...HEAD --stat` for build, CI and tooling changes, which go
  under Development.
- `git log --format='%s%n%b' main..HEAD` for intent.
- Read enough of the changed UI code to know each control's label and default
  as the app shows them.

## 3. Check each bullet

For each bullet, answer:

- **True?** The diff does what the bullet says. Labels, defaults and numbers
  match the code.
- **Visible?** A user-facing bullet describes something a user of the site
  can see. A Development bullet describes something a contributor uses: a
  `make` target, CI, the dev server. Tests and refactors fail both.
- **Right group?** Added, Changed, Removed, Fixed or Development.
- **Brief?** It follows the Brevity rules.

Then check the other way: list each change in the diff that a user or a
contributor would notice and that has no bullet.

## 4. Report

Report in chat, in this order:

1. Wrong bullets, each with the line of code that shows the truth.
2. Missing changes.
3. Bullets to cut or shorten, each with the shorter text.

Say "The entry is accurate" when nothing is found. Do not edit `CHANGELOG.md`
until the user asks. On request, edit the entry where it is: under
`## Unreleased`, or under the stamped version heading if the bump ran. Do not
touch any PR, and do not run `make pr`. After an edit, tell the user that
their next `make pr` updates the PR body.
