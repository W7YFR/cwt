# Contributing

## Workflow

The contributor runs every release step. Claude may create the branch, since
starting a task starts there. Claude never commits, because every commit
needs human review. Claude never runs `make bump`, `make pr`,
`make release` or `make tag`, never pushes, and never opens, edits or merges
a pull request.

When asked, Claude stages work for review. Work on several changes at once
can then be committed in parts: Claude stages the hunks for one part, and the
contributor reviews and commits it. Staging changes only the index. Claude
never resets or moves the branch. Claude may suggest a commit message for the
staged part, but the contributor commits it. A suggested message is one line:
a type prefix and a summary, such as `fix: caption a matched prosign`. It has
no body and no trailer.

1. Claude or the contributor branches from `main` with a type prefix:
   `feat/` (minor), `fix/` or `chore/` (patch). The prefix sets the version
   bump, so pick it from what the change is.
2. Claude implements the change and writes the `CHANGELOG.md` entry as the
   work lands. The contributor reviews and commits each piece.
3. The contributor may ask for `/changelog-check`, which verifies the entry
   against the diff.
4. The contributor runs `make pr`. It bumps the version, pushes, and opens
   the pull request. The title is `[TYPE] vX.Y.Z`. The body is the branch's
   changelog entry. A second run updates the pull request.
5. The contributor merges when CI is green.
6. The contributor runs `make release`. It updates `main`, tags and pushes
   the version with the entry as its notes, and deletes the merged branch.

A branch that touches no build input releases no version and needs no bump.
The contributor names its pull request with `make pr TITLE="..."`. The build
inputs are `BUILD_INPUTS` in `scripts/version.mjs`.

## Changelog

Every branch adds an entry to `CHANGELOG.md`. The entry is also the pull
request body, so it is the only description the change gets.

### When

Write or update the entry as the work lands, in the same session. Do not wait
for the end of the branch. Before the contributor runs `make pr`, the entry
must match the final diff.

### Where

Under `## Unreleased`, at the top. Never write a version heading. `make bump`
moves the text under `## vX.Y.Z — YYYY-MM-DD` in the release commit.

Other branches may have merged entries under `## Unreleased` that no release
has carried yet. Add to those groups. Do not edit their bullets.

### Shape

```
### Added

- **Fit WPM** sets both target speeds to the selected run's measured speeds.

### Fixed

- A prosign caption at the end of a message, such as `<SK>`, is no longer cut off.

### Development

- `make icons` builds the `.ico` and PNG icons from `app/public/favicon.svg`.
```

- Groups in this order, each only if it has items: Added, Changed, Removed,
  Fixed, Development.
- Added, Changed, Removed and Fixed are for people who use the site.
- Development is for contributors: the build, CI, `make` targets, the dev
  server and tooling. A branch that touches no build input writes only here.
- One bullet per change. One or two short sentences.
- Bold a control's name as the app labels it.
- A fix says what the user saw go wrong, not the cause.

### Brevity

- No tests, refactors, file names or function names outside Development.
- No reasons, mechanisms or history. Say what changed, not how.
- No numbers unless the reader sees them (a default, a speed, a width).
- One term per concept, the term the app uses.
- If a bullet needs a third sentence, cut it.
- Merge small related changes into one bullet.

## Writing style

For comments, commit messages and changelog entries. Model it on ASD-STE100
simplified technical English:

- One idea per sentence.
- Short declarative sentences.
- Active voice, present tense.
- No filler, no hedging, no preamble.
- One term per concept. Reuse the same word for the same thing.
