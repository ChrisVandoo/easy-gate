## easy-gate

Conditionally run Github Actions workflows and jobs in a way that doesn't suck and also you can reproduce locally.

## the problem
- conditionals all over the place
- scary conditionals like:
```
  if: >-
      !cancelled() &&
      (needs.should-run.outputs.verdict == 'force-run' ||
      needs.files-changed.outputs.embedding_sdk_components == 'true' ||
      needs.files-changed.outputs.frontend_sources == 'true' ||
      needs.files-changed.outputs.embedding_documentation == 'true' ||
      needs.files-changed.outputs.embedding_sdk_ci == 'true')
      ...
```
- repeatedly writing the same checks
- trying to assert that the things you expect actually ran without accidentally skipping something
- a job skipped but secretly and the Github UI isn't going to make it easy for you to figure out why that is
- and of course Github's implementation of [required checks](https://github.com/orgs/community/discussions/44490)... 

## how easy-gate helps
- A config file checked into source code that is the source of truth for what runs when. It reflects the structure of your workflows without 100s or 1000s of lines of inline scripts etc. obscuring these conditionals.
- Point it at your PR and it will produce the same test plan that CI uses to run your workflows. You can even point it at local changes and it should still work.

## usage
locally:
```
bun plan create --pr <pr #> --repo <owner/repo>
```
to see what CI jobs will run.

example CI usage:
- [ci.yml](.github/workflows/ci.yml)
- [test-plan.yaml](.github/test-plan.yaml)

### test-plan.yaml syntax rules
  - overrides ALWAYS take precedence over workflow level settings
  - default: `condition: all` for skip and run blocks for example: a label `skip-all` AND this is a PR == this job is skipped
  - optionally can specify `condition: any` in which case if any of label, event, branch, or path matches skip/run will execute
  - if run and skip both match, run ALWAYS takes precedence and the job/workflow will run
  - force-skip ALWAYS takes precedence over run and skips the job or workflow