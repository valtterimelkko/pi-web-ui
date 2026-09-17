# CI pipeline

What the GitHub Actions pipeline runs, why it is shaped this way, and what to
check before changing its triggers.

## The two workflows

| Workflow | File | Trigger | Runs |
|---|---|---|---|
| Docs checks | `.github/workflows/docs.yml` | **every** push and pull request, no path filter | `docs:check-agent-guides`, `docs:check-links` |
| Application correctness | `.github/workflows/application.yml` | every push and pull request **except documentation-only changes** | lint, changed-source warning ratchet, typecheck, build, `test:coverage` |

The documentation checks live in their own always-on workflow because the
correctness workflow skips documentation-only changes. Both docs scripts use
only Node built-ins, so that workflow needs no `npm ci` and completes in about
**13 seconds**.

## Why documentation-only changes skip the correctness suite

Measured before this split, on run `35244176633` (total **672 s**):

| Step | Duration |
|---|---|
| `npm ci` | 105.0 s |
| **docs checks** | **0.35 s** |
| lint | 16.1 s |
| changed-source warning ratchet | 16.6 s |
| typecheck | 20.0 s |
| build | 27.0 s |
| `npm test` | 216.6 s |
| `test:coverage` | ~250 s |

The documentation checks cost **0.35 s of a 672 s job (0.05%)**. Every other
step is unaffected by a Markdown edit, so a documentation-only push previously
paid roughly eleven minutes for a third of a second of relevant work. On
2026-09-17 the repository produced twelve such runs in one afternoon, about
85 minutes of runner time, with four overlapping pairs.

Three changes address that, in order:

1. **`concurrency`** on the correctness workflow, group
   `${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true`.
   Superseded pushes stop burning a runner. A superseded run reports
   `cancelled`, never `success`, so nothing may read a cancelled run as a
   passing gate. `master` carries no branch protection, and neither this
   repository nor `agent-os` polls these check names, so no merge gate depends
   on the conclusion of a superseded run.
2. **The docs split**, so documentation-only changes skip the suite entirely
   while the docs checks still run on every push.
3. **One suite run instead of two.** `npm test` and `test:coverage` both
   delegate to `scripts/test-workspaces.mjs`, so both ran the same workspaces,
   the same specs and the same discovery gates, and the coverage run
   additionally enforces the per-workspace thresholds configured in every vitest
   config. Nothing uploads coverage, so it is a gate, not a report. Running both
   was ~217 s of duplicate work per push.

## The exemption list is load-bearing

A skipped job reports no failure at all, so over-ignoring turns a broken build
into a silently green push. The dangerous case is real and was found while
writing this list:

`docs/INTERNAL-API-CONTRACT.md` is a **test input**.
`server/tests/unit/internal-api/contract-version-drift.test.ts` reads it and
asserts the version constant, the changelog entry and the published example all
agree. A naive `docs/**` ignore would let a change to that document break the
suite without CI saying anything.

So `application.yml` ignores `**.md` and then re-includes, with a leading `!`,
every Markdown file that the correctness suite actually reads. At the time of
writing there are eleven. The list is defined once with a YAML anchor and
aliased for `pull_request`, so the two events cannot drift apart.

## Measured results

Verified on 2026-09-17 against `master`.

| Push | Before | After |
|---|---|---|
| Documentation-only | 672 s (full suite) | **13 s** — Docs checks only; the correctness run is not created at all |
| Any other | 672 s | **472 s** |

A full run after the change (run `35248040340`, job 469 s), per step:

| Step | Duration |
|---|---|
| checkout | 2.9 s |
| setup-node | 8.3 s |
| `npm ci` | 107.5 s |
| lint | 16.6 s |
| changed-source warning ratchet | 16.4 s |
| typecheck | 20.9 s |
| build | 28.0 s |
| `test:coverage` | 262.2 s |

`npm ci` is now about 23% of a full run and the suite about 56%; nothing in
this work reduces either. The suite figure rose slightly against the baseline
(250 s to 262 s), which is ordinary run-to-run variance and not a cost of
running it once.

Documentation-only pushes skipping the suite was confirmed on live traffic, not
only on a scratch branch: commit `cd2f876` added a single 408-line document and
produced a Docs checks run with no correctness run at all.

## The guard test

`server/tests/unit/ci-workflow-paths.test.ts` enforces both halves of the
design, so the list cannot rot silently:

- no Markdown file named by the code or tests the suite runs may be ignored. The
  set is discovered by scanning `server/src`, `server/tests`, `client/src`,
  `shared/src` and `packages` for Markdown literals that resolve to real tracked
  files;
- at least one tracked document must still be skipped, or the globs have become
  inert and the optimisation has bought nothing;
- implementation sources and workflow files must never be ignored;
- the docs checks must remain in a workflow with no path filter, and that
  workflow must not be the correctness workflow.

Discovery is deliberately conservative: any Markdown path that appears as a
string in suite code counts as consumed, even when it is only data, such as an
error body's `docs:` field. A false positive costs one document its skip; a
false negative costs a silent green push. The scan is a floor on the protected
set, not proof of completeness — paths assembled dynamically cannot be found
this way.

The guard was verified RED before the split, and afterwards by two mutations:
dropping one exemption, and emptying the ignore list. Each fails with its
intended message.

## Changing a trigger: verify before trusting

GitHub evaluates `paths`/`paths-ignore` itself, and its negation semantics
cannot be checked locally. Verify on a scratch branch, never on `master`:

1. branch from the current head and push it;
2. push a change touching **only a non-exempt** document — expect the Docs
   checks workflow and **no** Application correctness run;
3. push a change touching **only an exempt** document — expect **both**
   workflows to run;
4. delete the branch and any local worktree.

Use a git worktree for step 2 rather than the shared checkout. The first attempt
at this verification was done without leaving `master`, which committed a test
marker to `master` and let it be published; that is the mistake this section
exists to prevent.

Verified on 2026-09-17:

| Change | Result |
|---|---|
| workflow files only | both workflows ran |
| `docs/AGENT-ORIENTATION.md` only (non-exempt) | Docs checks only; correctness **not** created |
| `docs/OBSERVABILITY.md` only (exempt) | Docs checks **and** Application correctness |

## What not to do

- **Do not replace the exemption list with `docs/**` or `**/*.md` alone.** The
  contract document is a test input; see above.
- **Do not move the docs checks back into the correctness workflow.** That
  restores the coupling where a broken relative link fails the same job as a
  failing test suite, and makes it impossible to skip the suite for docs.
- **Do not read a cancelled or absent correctness run as a passing gate.**
- **Do not add `npm test` back without a reason.** If a failure needs
  attributing between the instrumented and uninstrumented runs, that is the
  reason, and the comment in `application.yml` says so.
