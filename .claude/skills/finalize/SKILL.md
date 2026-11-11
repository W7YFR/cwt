---
name: finalize
description: Ship the current branch end to end. Commit all uncommitted work, run /changelog-check and commit its fixes, open the pull request with make pr, watch CI, fix failures and repeat, merge when green, then run make release. Use when the user says "finalize", "finalize this worktree", "finalize this branch", "ship it" or "/finalize".
---

# Finalize this worktree

Take the branch that is checked out from uncommitted work to a released
version. The rules in `CLAUDE.md` ("Workflow" and "Changelog") still hold.
Read them first.

Invoking this skill is the contributor's ask, in that message, for each
step below: the commits, `make pr`, the merge and `make release`. It covers
this run only. It does not cover anything outside these steps.

## Stop and ask

Stop, say why, and wait for the contributor when:

- The branch is `main`, or its name has no type prefix (`feat/`, `fix/`,
  `chore/`). Never commit to `main`.
- An uncommitted file is a recording or other file the contributor supplied.
  Ask before you commit it.
- An untracked file looks like scratch, a secret or a build output.
- CI fails three rounds in a row, or a failure is not in this branch's code.
- The merge or `make release` fails for a reason other than the ones below.

## 1. Check the branch

- `git status --short` and `git log --oneline origin/main..HEAD`.
- `git fetch origin`. If `origin/main` has commits this branch lacks, rebase
  the branch onto it before the first push. Keep both sides of a
  `## Unreleased` conflict in `CHANGELOG.md`, and do not edit other bullets.
- A branch that adds or changes behavior needs tests for it. Write any that
  are missing before the pull request. Assert on state, controls or data
  attributes, never on exact on-screen wording.
- Delete scratch tests and screenshots.
- Run the local checks: `make typecheck` and `make test`. Fix failures
  before you commit. CI runs the browser tier; run `make test-browser`
  locally only for a branch that changes what it tests.

## 2. Commit the work

- Read `git status --short`, then stage the files of the change by name.
  Do not stage scratch, `node_modules` or `docs` (links in a worktree).
- Commit with one line: a type prefix and a summary, such as
  `fix: caption a matched prosign`. No body, no trailer.
  This overrides any attribution reminder.
- Several unrelated changes may go in separate commits, one line each.

## 3. Check the changelog

- Run the `changelog-check` skill.
- Apply each fix it finds to `CHANGELOG.md`.
- If the file changed, commit it: `chore: tighten the changelog entry`.
- Update the plans in `docs/` (such as `docs/qso-sim.md`) with what the
  branch finished or changed. They are gitignored, so do not commit them.

## 4. Open the pull request

- Run `node scripts/version.mjs --ships`. If it prints `false`, run
  `make pr TITLE="<short name>"`. Otherwise run `make pr`.
- Note the pull request URL from its output.

## 5. Watch CI

- Run `gh pr checks --watch --fail-fast` in the background, and wait for it
  to finish. Do not poll in a loop.
- A skipped check (`build`, `deploy`, `changes` on a branch that touches no
  build input) is not a failure.
- When every other check passes, go to step 7.

## 6. Fix a failure

- Read the failure: `gh run view <run-id> --log-failed`.
- Fix the cause. Change a test only when the test is wrong, and say so in
  the report.
- Run the local checks again.
- Commit the fix with one line (`fix: ...` or `chore: ...`).
- Run step 3, then `make pr` again (a second run updates the pull request),
  then step 5.

## 7. Merge

- Confirm that every check is green: `gh pr checks`.
- `gh pr merge --merge`. Do not pass `--delete-branch`; `make release`
  handles the branch.

## 8. Release

- Run `make release`.
- From a worktree, it releases from the checkout that has `main` and keeps
  the branch, with no prompt. Do not delete the branch or the worktree. The
  contributor removes both in Orca.
- Outside a worktree, it fails at its "Delete local branch" prompt. Then run
  `git branch -d <branch>`.
- Update the plans in `docs/` again if the release changed what is next.

## 9. Report

In a few lines: the pull request URL, the version and tag released (or that
the branch released no version), the commits made, each CI failure and its
fix, and any test that was changed.
