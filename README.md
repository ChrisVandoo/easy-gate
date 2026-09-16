# stack-test

Testing Github Stacks

## CI

CI decides what to run once, up front, and writes it down. That artefact is the
**test plan**: a JSON object saying which workflows run, which jobs inside them
run, and why. Every later job reads the plan instead of working the answer out
again, and a final required check confirms the run did what the plan said.

```
$ bun run plan create --pr 9

event:    pull_request
ref:      bump-checkout-v6 -> main
labels:   (none)
changed:  workflows (3 file(s))
override: (none)

RUN  ci
  RUN  plan         exempt from filters, always runs
  RUN  lint         the lint workflow has jobs to run
  SKIP test         nothing to run in the test workflow
  RUN  required     gate job, always runs
RUN  lint
  RUN  lint         changed: workflows
  RUN  verify       gate job, always runs
SKIP test
  SKIP test         no changes in src
  RUN  verify       gate job, always runs
RUN  info
  RUN  plan         exempt from filters, always runs
  RUN  debug        changed: workflows
```

### What decides

In order:

| | |
| --- | --- |
| `skip-all` label | nothing runs |
| `force-run` label | everything runs, whatever changed |
| nothing to diff against | everything runs — a new branch, or a root commit |
| push to `main` | everything runs |
| otherwise | each job runs if its [path groups](.github/paths-filter.yaml) changed |

An override settles every job on its own, so when one applies `create` never
works the diff out at all — no `git diff` on the default branch, no `gh pr diff`
behind `force-run` or `skip-all`. The plan records `changedFiles: null` to say
the question was never asked, which is different from asking and finding
nothing. This falls out of the types: predicates take `PlanContext`, which has
no diff in it, so a predicate cannot come to depend on one by accident.

Recognising that there is nothing to diff against is the tool's job too, not the
workflow's: `create` treats an all-zero `--base` (what a push reports when it
creates the branch) and a commit with no parent as the same case.

The required check runs in every one of those cases, including `skip-all`, so a
pull request is always mergeable on its own terms rather than stuck waiting for
a check that was never going to report.

Labels are read live from the API, not from the event payload, and `labeled` /
`unlabeled` are CI triggers — so adding `force-run` to an open pull request
re-runs it, and re-running an old run picks up the labels as they are now.

### Configuring it

[`.github/test-plan.yaml`](.github/test-plan.yaml) holds both halves: the
ordered `overrides` (first match wins) and the `workflows` with their jobs.

```yaml
workflows:
  ci:
    jobs:
      test:
        calls: test      # this job's body is `uses: ./.github/workflows/test.yml`
      required:
        gate: true       # always runs, and does the verifying

  test:                  # ...and the workflow it calls is described here too
    jobs:
      test:
        paths: [src]     # runs when the `src` group changed
        when:
          - labels: [deep-test]   # ...and whenever this label is on the PR
      verify:
        gate: true
```

A job with no `paths` is unconditional; `exempt: true` opts it out of overrides
and filters entirely. An override's `when` is an AND of predicates — `labels`,
`branch`, `event`, `draft` today. Adding a new input means adding one
entry to `PREDICATES` in [`.github/scripts/test-plan.ts`](.github/scripts/test-plan.ts)
and one field to `PlanInputs`; nothing else in the pipeline changes.

A job takes a `when` of its own, and that one is a list: the same predicates,
but any entry matching is enough, because each is another reason to want this
particular job. It is a conditional `exempt` — asking for a job is asking for it
to run, so a job asked for here runs even under `skip-all`. It cannot turn a job
off: an entry that does not match simply leaves the path filter to decide.

```
RUN  ci
  RUN  plan         exempt from filters, always runs
  SKIP lint         nothing to run in the lint workflow
  RUN  test         the test workflow has jobs to run
  RUN  required     gate job, always runs
RUN  test
  RUN  test         asked for by labels: deep-test
  RUN  verify       gate job, always runs
```

#### Workflows that call workflows

A workflow called with `uses:` is described here like any other, so one file
still answers "why did this run?" for the whole tree. The calling job gets
`calls:` and nothing else — it decides nothing of its own, it runs exactly when
the workflow it names has work in it. So a nested job's path filter reaches all
the way up, and a `deep-test` label on a job three levels down is what makes the
job at the top run:

```
RUN  ci
  RUN  test         the test workflow has jobs to run
RUN  test
  RUN  test         asked for by labels: deep-test
```

A called workflow has to carry a `gate` of its own, and `parseConfig` refuses
one that doesn't. This is not a style rule: a caller's `needs` context holds the
called workflow's *overall* result and never the jobs inside it, so the caller
cannot tell whether a nested job the plan asked for actually ran. The called
workflow checks that itself, against the same plan — the caller passes it down
as a `workflow_call` input rather than anyone deriving it twice — and a mismatch
surfaces upward as that workflow failing.

#### The size ceiling

`create` refuses to emit a plan over 1 MB, which is what a job output can carry
— and the plan is a job output before it is anything else, read back out of
`needs` by every `if:` and handed down to each called workflow on top of that.

```
The plan is 1748 KB, over the 1024 KB a job output can carry.
```

Failing here is deliberate. A plan that does not arrive intact does not fail at
the far end: `fromJSON` cannot read it, every `if:` consulting it comes out
false, and the run skips everything while reporting success. A loud failure with
no plan beats a quiet green run that tested nothing.

Only `changedFiles` grows without bound, so hitting this almost always means the
base is wrong rather than the change being genuinely enormous — check what
`--base` resolved to first.

`labels` and `branch` match on globs, so each entry is either a plain name,
which has to match exactly, or a pattern — `*` stopping at a `/` and `**` not:

```yaml
overrides:
  - id: protected-branch
    when:
      branch: [main, "release/**"]   # which branches these are is config,
    decision: run                    # not something CI passes in
    reason: pushes to a protected branch always run everything
```

`branch` matches the branch the commits are on, which for a pull request is its
head branch, not the branch it will merge into — so a branch override fires on
a push to `main` and not on a pull request into `main`.

A diff that cannot be worked out is not an override, because it is not a
property of the inputs: `create` tries the diff, and if git or the API will not
answer — a branch that has just been created, a force-pushed base, a clone too
shallow to reach it — the plan runs everything and says so.

```
changed:  (no diff — diff-failed decides)
override: diff-failed
```

The alternative would be reading an unavailable diff as an empty one and
skipping every job on no evidence.

Two mistakes are caught by `bun test` rather than by a failing run: filtering on
a path group that does not exist, and a job in the config that does not match
the jobs in the workflow file (or that the gate job forgot to `needs`).

### The CLI

Same code path locally and in CI, so a local plan and a CI plan agree.

```bash
# What will CI do for this pull request?
bun run plan create --pr 9

# ...or the same pull request as if it were labelled force-run
bun run plan create --pr 9 --label force-run

# ...or for the working tree, with inputs spelled out
bun run plan create --event pull_request --base main --ref my-branch

# Should one job run, given a plan?
bun run plan execute --plan plan.json --workflow ci --job test   # -> true | false

# Did the run do what the plan said? (this is the required check)
bun run plan verify --plan plan.json --workflow ci --results "$NEEDS"

# Every command and flag, from the tool itself
bun run plan --help
bun run plan create --help
```

The help is checked: a test fails if the script reads a flag the help does not
mention, so `--help` is the list to trust rather than this one.

`create` takes `--pr` (via `gh`) or `--event` / `--ref` / `--base` / `--head`,
and writes the plan to `--out` and to `GITHUB_OUTPUT`.
`--label` works with both: on a pull request it adds to the labels the API
reports, so you can try a label out without setting it. `execute` prints `true` or `false` with the reason on stderr.
`verify` exits non-zero when a planned job did not succeed, when a job the plan
ruled out ran anyway, or when a planned job never reached the gate's `needs`.

### The required check

`required` in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) is the only
check to mark as required in branch protection. It runs `if: always()`, takes
the plan and `toJSON(needs)`, and fails if either side drifted:

```
PASS plan         success   exempt from filters, always runs
PASS lint         success   changed: workflows
PASS test         skipped   no changes in src

All 3 job(s) matched the plan.
```
