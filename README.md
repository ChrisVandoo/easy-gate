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
  RUN  lint         changed: workflows
  SKIP test         no changes in src
  RUN  required     gate job, always runs
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
| push to `main` | everything runs |
| otherwise | each job runs if its [path groups](.github/paths-filter.yaml) changed |

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
        paths: [src]     # runs when the `src` group changed
      required:
        gate: true       # always runs, and does the verifying
```

A job with no `paths` is unconditional; `exempt: true` opts it out of overrides
and filters entirely. An override's `when` is an AND of predicates — `labels`,
`event`, `defaultBranch`, `draft` today. Adding a new input means adding one
entry to `PREDICATES` in [`.github/scripts/test-plan.ts`](.github/scripts/test-plan.ts)
and one field to `PlanInputs`; nothing else in the pipeline changes.

Two mistakes are caught by `bun test` rather than by a failing run: filtering on
a path group that does not exist, and a job in the config that does not match
the jobs in the workflow file (or that the gate job forgot to `needs`).

### The CLI

Same code path locally and in CI, so a local plan and a CI plan agree.

```bash
# What will CI do for this pull request?
bun run plan create --pr 9

# ...or for the working tree, with inputs spelled out
bun run plan create --event pull_request --base main --label force-run

# Should one job run, given a plan?
bun run plan execute --plan plan.json --workflow ci --job test   # -> true | false

# Did the run do what the plan said? (this is the required check)
bun run plan verify --plan plan.json --workflow ci --results "$NEEDS"
```

`create` takes `--pr` (via `gh`) or `--event` / `--ref` / `--base` / `--head` /
`--label` / `--default-branch`, and writes the plan to `--out` and to
`GITHUB_OUTPUT`. `execute` prints `true` or `false` with the reason on stderr.
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
