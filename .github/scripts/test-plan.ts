#!/usr/bin/env bun
/**
 * Builds and reads the CI test plan.
 *
 * A plan is a plain JSON object that records, for one set of inputs, which
 * workflows run and which jobs inside them run — plus the reason for each
 * decision. CI builds the plan once, up front, and every later job reads it
 * instead of re-deriving the answer, so there is a single place where "does
 * this run?" is decided and a single artefact to look at when it surprises you.
 *
 * `create` resolves its inputs from a pull request (--pr, via gh) or from the
 * flags directly, so the same command run on a laptop and in CI produces the
 * same plan. `execute` answers a single should-this-run question. `verify` is
 * the required check: it takes the plan and the `needs` context and confirms
 * every job the plan asked for actually ran and passed.
 *
 * The flags live with the commands themselves, at the bottom of this file:
 * run `test-plan.ts --help`, or `test-plan.ts <command> --help`.
 */

import {
  changedFiles,
  defaultBase,
  matchGroups,
  parseFilters,
} from "./paths-filter.ts";

export const PLAN_VERSION = 1;

/**
 * Everything known without looking at the diff. Overrides decide from this
 * alone — which is what lets `create` skip working the diff out at all when
 * one of them applies. Extend this to add a new input.
 */
export type PlanContext = {
  event: string;
  ref: string;
  baseRef: string | null;
  draft: boolean;
  labels: string[];
};

/** What changed, once someone actually needs to know. */
export type PlanDiff = {
  changedFiles: string[];
  changedGroups: string[];
};

/**
 * What the plan records: the context, and the diff if one was needed. Both
 * lists are null when there is no diff, either because an override settled
 * everything without one or because working it out failed; `override` says
 * which.
 */
export type PlanInputs = PlanContext & {
  changedFiles: string[] | null;
  changedGroups: string[] | null;
};

export type JobPlan = { run: boolean; reason: string };
export type WorkflowPlan = { run: boolean; jobs: Record<string, JobPlan> };

export type TestPlan = {
  version: number;
  createdAt: string;
  inputs: PlanInputs;
  override: string | null;
  workflows: Record<string, WorkflowPlan>;
};

export type Predicate = Record<string, unknown>;

export type Override = {
  id: string;
  when: Predicate;
  decision: "run" | "skip";
  reason: string;
};

export type JobConfig = {
  /**
   * The workflow this job calls, for a job whose whole body is `uses:`. Such a
   * job decides nothing itself — it runs exactly when the workflow it calls has
   * work in it — so the called workflow's own jobs, described here like any
   * other, are what settle it.
   */
  calls?: string;
  paths?: string[];
  /**
   * Conditions that make this job run whatever the diff says. Any one of them
   * matching is enough — unlike an override's `when`, which is an AND of its
   * predicates, a list of them is an OR, because each entry is another reason
   * this particular job is wanted.
   */
  when?: Predicate[];
  exempt?: boolean;
  gate?: boolean;
};

export type PlanConfig = {
  overrides: Override[];
  workflows: Record<string, Record<string, JobConfig>>;
};

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * The predicates an override's `when` may use. A new input is a new entry here
 * plus a field on PlanContext — nothing else in the pipeline needs to change.
 *
 * They take the context rather than the whole plan inputs on purpose: a
 * predicate that could read the diff would defeat skipping it.
 */
export const PREDICATES: Record<
  string,
  (value: unknown, context: PlanContext) => boolean
> = {
  labels: (value, context) =>
    matchesAny(stringList(value, "labels"), context.labels),
  branch: (value, context) =>
    matchesAny(stringList(value, "branch"), [context.ref]),
  event: (value, context) => stringList(value, "event").includes(context.event),
  draft: (value, context) => value === context.draft,
};

/**
 * True when any pattern matches any value. Patterns are globs, so a plain name
 * with no wildcard in it is simply an exact match — which is what lets one
 * list hold `main`, `release/*` and `renovate/**` side by side. As usual `*`
 * stops at a `/` and `**` does not.
 */
function matchesAny(patterns: string[], values: string[]): boolean {
  return patterns.some((pattern) => {
    const glob = new Bun.Glob(pattern);

    return values.some((value) => glob.match(value));
  });
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`predicate "${field}" must be a list of strings`);
  }

  return value as string[];
}

/** An empty `when` matches nothing; otherwise every predicate must hold. */
export function matchesPredicate(
  predicate: Predicate,
  context: PlanContext,
): boolean {
  const entries = Object.entries(predicate);

  if (entries.length === 0) {
    return false;
  }

  return entries.every(([name, value]) => {
    const test = PREDICATES[name];

    if (!test) {
      throw new Error(
        `unknown predicate "${name}", expected one of ${Object.keys(PREDICATES).join(", ")}`,
      );
    }

    return test(value, context);
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A job's `when` is a list of predicates, not the single mapping an override
 * takes, so the common case — one label — still reads as one line of YAML.
 */
function parseJobWhen(value: unknown, job: string): Predicate[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`job "${job}".when must be a list of \`when\` mappings`);
  }

  return value as Predicate[];
}

export function parseConfig(source: string): PlanConfig {
  const parsed = Bun.YAML.parse(source);

  if (!isRecord(parsed)) {
    throw new Error("test plan config must be a mapping");
  }

  const rawOverrides = parsed.overrides ?? [];

  if (!Array.isArray(rawOverrides)) {
    throw new Error("`overrides` must be a list");
  }

  const overrides = rawOverrides.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`override ${index} must be a mapping`);
    }

    const id = typeof raw.id === "string" ? raw.id : `override-${index}`;

    if (raw.decision !== "run" && raw.decision !== "skip") {
      throw new Error(`override "${id}" needs decision: run | skip`);
    }

    if (!isRecord(raw.when)) {
      throw new Error(`override "${id}" needs a \`when\` mapping`);
    }

    return {
      id,
      when: raw.when as Predicate,
      decision: raw.decision,
      reason: typeof raw.reason === "string" ? raw.reason : id,
    } satisfies Override;
  });

  if (!isRecord(parsed.workflows)) {
    throw new Error("`workflows` must be a mapping of workflow name to jobs");
  }

  const workflows: PlanConfig["workflows"] = {};

  for (const [workflow, rawWorkflow] of Object.entries(parsed.workflows)) {
    if (!isRecord(rawWorkflow) || !isRecord(rawWorkflow.jobs)) {
      throw new Error(`workflow "${workflow}" needs a \`jobs\` mapping`);
    }

    const jobs: Record<string, JobConfig> = {};

    for (const [job, rawJob] of Object.entries(rawWorkflow.jobs)) {
      // `job:` with nothing under it parses as null, and means "no options".
      const options = rawJob ?? {};

      if (!isRecord(options)) {
        throw new Error(`job "${workflow}/${job}" must be a mapping`);
      }

      if (options.paths !== undefined) {
        stringList(options.paths, `${workflow}/${job}.paths`);
      }

      jobs[job] = {
        calls: parseCalls(options, `${workflow}/${job}`),
        paths: options.paths as string[] | undefined,
        when: parseJobWhen(options.when, `${workflow}/${job}`),
        exempt: options.exempt === true,
        gate: options.gate === true,
      };
    }

    workflows[workflow] = jobs;
  }

  validateCalls(workflows);

  return { overrides, workflows };
}

/** `calls` is the whole of a job's configuration, so nothing may sit beside it. */
function parseCalls(
  options: Record<string, unknown>,
  job: string,
): string | undefined {
  if (options.calls === undefined) {
    return undefined;
  }

  if (typeof options.calls !== "string") {
    throw new Error(`job "${job}".calls must be the name of a workflow`);
  }

  const clashes = ["paths", "when", "exempt", "gate"].filter(
    (key) => options[key] !== undefined,
  );

  if (clashes.length > 0) {
    throw new Error(
      `job "${job}" cannot combine \`calls\` with ${clashes.join(", ")} — the jobs of the called workflow decide whether it runs`,
    );
  }

  return options.calls;
}

/**
 * A called workflow has to be described here, and has to carry its own gate.
 * The caller cannot verify it: a caller's `needs` context only ever holds the
 * called workflow's overall result, never the jobs inside it, so a nested job
 * that the plan asked for and that never ran would go unnoticed.
 */
function validateCalls(workflows: PlanConfig["workflows"]): void {
  for (const [workflow, jobs] of Object.entries(workflows)) {
    for (const [job, options] of Object.entries(jobs)) {
      if (options.calls === undefined) {
        continue;
      }

      const called = workflows[options.calls];

      if (!called) {
        throw new Error(
          `job "${workflow}/${job}" calls workflow "${options.calls}", which is not described here — add it under \`workflows\``,
        );
      }

      if (!Object.values(called).some((option) => option.gate)) {
        throw new Error(
          `workflow "${options.calls}" is called by "${workflow}/${job}", so it needs a \`gate\` job of its own — a caller cannot see the jobs inside it`,
        );
      }
    }
  }
}

/** Catches a `paths` group that no longer exists in the paths-filter config. */
export function validateGroups(config: PlanConfig, known: string[]): void {
  for (const [workflow, jobs] of Object.entries(config.workflows)) {
    for (const [job, options] of Object.entries(jobs)) {
      for (const group of options.paths ?? []) {
        if (!known.includes(group)) {
          throw new Error(
            `job "${workflow}/${job}" filters on unknown path group "${group}", expected one of ${known.join(", ")}`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Creating a plan
// ---------------------------------------------------------------------------

export function selectOverride(
  config: PlanConfig,
  context: PlanContext,
): Override | null {
  return (
    config.overrides.find((override) =>
      matchesPredicate(override.when, context),
    ) ?? null
  );
}

/** `labels: [a, b], branch: [main]` — an override's `when` as one line. */
function describePredicate(predicate: Predicate): string {
  return Object.entries(predicate)
    .map(([name, value]) => `${name}: ${[value].flat().join(", ")}`)
    .join(" and ");
}

export function planJob(
  options: JobConfig,
  context: PlanContext,
  override: Override | null,
  changedGroups: string[],
): JobPlan {
  if (options.gate) {
    return { run: true, reason: "gate job, always runs" };
  }

  if (options.exempt) {
    return { run: true, reason: "exempt from filters, always runs" };
  }

  // A job's own `when` is a conditional `exempt`, and sits where `exempt` does:
  // asking for a job by label is asking for it to run, so it outranks a blanket
  // skip in the same way. Nothing here can turn a job off — a `when` that does
  // not match just leaves the path filter to decide as it would have.
  const wanted = options.when?.find((predicate) =>
    matchesPredicate(predicate, context),
  );

  if (wanted) {
    return { run: true, reason: `asked for by ${describePredicate(wanted)}` };
  }

  if (override) {
    return { run: override.decision === "run", reason: override.reason };
  }

  if (options.paths === undefined) {
    return { run: true, reason: "no path filter" };
  }

  const hits = options.paths.filter((group) => changedGroups.includes(group));

  return hits.length > 0
    ? { run: true, reason: `changed: ${hits.join(", ")}` }
    : { run: false, reason: `no changes in ${options.paths.join(", ")}` };
}

/** The id the plan carries when everything ran because the diff failed. */
export const DIFF_FAILED = "diff-failed";

/**
 * The blanket decision taken when we cannot tell what changed.
 *
 * Nothing in the config can express this, because it is not a property of the
 * inputs: it is what is left when git or the API will not answer. A push that
 * creates a branch (whose `before` is all zeroes), a force-push that left the
 * base pointing at a commit nobody has any more, a clone too shallow to reach
 * it — all of them land here and all of them mean the same thing. Running
 * everything is the only honest answer, since the alternative is skipping jobs
 * on no evidence at all.
 */
const diffFailed: Override = {
  id: DIFF_FAILED,
  when: {},
  decision: "run",
  reason: "could not work out what changed, so everything runs",
};

/**
 * Plans every workflow, and a called one before its caller.
 *
 * Calls are what let one config govern workflows that call each other: the
 * calling job is not planned from its own options, it simply takes the answer
 * the called workflow arrived at, which is the same "is there real work here?"
 * rule a top-level workflow uses. So a nested job's path filter reaches all the
 * way up, and there is one place to look to see why any of it ran.
 */
function planWorkflows(
  config: PlanConfig,
  context: PlanContext,
  override: Override | null,
  changedGroups: string[],
): Record<string, WorkflowPlan> {
  const planned: Record<string, WorkflowPlan> = {};
  const calling: string[] = [];

  const planWorkflow = (workflow: string): WorkflowPlan => {
    const done = planned[workflow];

    if (done) {
      return done;
    }

    if (calling.includes(workflow)) {
      throw new Error(
        `workflow "${workflow}" ends up calling itself: ${[...calling, workflow].join(" -> ")}`,
      );
    }

    const jobConfigs = config.workflows[workflow];

    if (!jobConfigs) {
      throw new Error(
        `workflow "${workflow}" is called but not described in the config`,
      );
    }

    calling.push(workflow);

    const jobs: Record<string, JobPlan> = {};

    for (const [job, options] of Object.entries(jobConfigs)) {
      jobs[job] = options.calls
        ? planCall(options.calls, planWorkflow(options.calls))
        : planJob(options, context, override, changedGroups);
    }

    calling.pop();

    // A workflow is worth running when it has real work in it — a gate or an
    // exempt bookkeeping job on its own does not count.
    const workflowPlan: WorkflowPlan = {
      run: Object.entries(jobs).some(
        ([job, plan]) =>
          plan.run && !jobConfigs[job]?.gate && !jobConfigs[job]?.exempt,
      ),
      jobs,
    };

    planned[workflow] = workflowPlan;

    return workflowPlan;
  };

  // Planned depth-first, but reported in the order the config lists them, so
  // reading a plan follows the same path as reading the file it came from.
  return Object.fromEntries(
    Object.keys(config.workflows).map((workflow) => [
      workflow,
      planWorkflow(workflow),
    ]),
  );
}

function planCall(workflow: string, called: WorkflowPlan): JobPlan {
  return called.run
    ? { run: true, reason: `the ${workflow} workflow has jobs to run` }
    : { run: false, reason: `nothing to run in the ${workflow} workflow` };
}

/**
 * `diff` is a thunk because an override settles every job on its own: on a
 * protected branch, or behind force-run or skip-all, there is no question left
 * for the diff to answer, so it is never asked. When it is asked and throws,
 * that is not an error to fail the run with — it is the diff-failed decision.
 */
export function createPlan(
  config: PlanConfig,
  context: PlanContext,
  diff: () => PlanDiff,
): TestPlan {
  let override = selectOverride(config, context);
  let changes: PlanDiff | null = null;

  if (!override) {
    try {
      changes = diff();
    } catch {
      override = diffFailed;
    }
  }

  const workflows = planWorkflows(
    config,
    context,
    override,
    changes?.changedGroups ?? [],
  );

  return {
    version: PLAN_VERSION,
    createdAt: new Date().toISOString(),
    inputs: {
      ...context,
      changedFiles: changes?.changedFiles ?? null,
      changedGroups: changes?.changedGroups ?? null,
    },
    override: override?.id ?? null,
    workflows,
  };
}

/**
 * How big a plan may get. GitHub caps a job output at 1 MB, and the plan is a
 * job output before it is anything else — `ci` publishes it, every `if:` reads
 * it back out of `needs`, and each called workflow takes it as a `workflow_call`
 * input on top of that.
 */
export const MAX_PLAN_BYTES = 1024 * 1024;

function describeBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(bytes < 1024 * 10 ? 1 : 0)} KB`;
}

/**
 * Turns a plan into the string CI passes around, refusing one too big to make
 * the trip.
 *
 * Failing here is the point. A plan that does not arrive intact does not fail
 * loudly at the far end: `fromJSON` cannot read it, every `if:` that consults
 * it comes out false, and the run quietly skips everything while reporting
 * success. Better to have no plan and say why than a plan nobody can read.
 */
export function serializePlan(
  plan: TestPlan,
  max: number = MAX_PLAN_BYTES,
): string {
  const json = JSON.stringify(plan);
  const bytes = new TextEncoder().encode(json).length;

  if (bytes > max) {
    throw new Error(
      `The plan is ${describeBytes(bytes)}, over the ${describeBytes(max)} a job output can carry.`,
    );
  }

  return json;
}

// ---------------------------------------------------------------------------
// Reading a plan
// ---------------------------------------------------------------------------

export function parsePlan(source: string): TestPlan {
  const trimmed = source.trim();

  if (trimmed.length === 0) {
    throw new Error(
      "the plan is empty — the job that creates it probably failed",
    );
  }

  const plan = JSON.parse(trimmed) as TestPlan;

  if (plan.version !== PLAN_VERSION) {
    throw new Error(
      `plan version ${plan.version} is not supported, expected ${PLAN_VERSION}`,
    );
  }

  return plan;
}

export function lookupWorkflow(plan: TestPlan, workflow: string): WorkflowPlan {
  const found = plan.workflows[workflow];

  if (!found) {
    throw new Error(
      `the plan has no workflow "${workflow}", only ${Object.keys(plan.workflows).join(", ")}`,
    );
  }

  return found;
}

export function lookupJob(
  plan: TestPlan,
  workflow: string,
  job: string,
): JobPlan {
  const found = lookupWorkflow(plan, workflow).jobs[job];

  if (!found) {
    throw new Error(
      `the plan has no job "${workflow}/${job}", only ${Object.keys(lookupWorkflow(plan, workflow).jobs).join(", ")}`,
    );
  }

  return found;
}

// ---------------------------------------------------------------------------
// Verifying a finished run
// ---------------------------------------------------------------------------

export type JobResult = { result?: string };
export type Results = Record<string, JobResult>;

export type Check = {
  job: string;
  expected: "run" | "skip";
  result: string;
  ok: boolean;
  detail: string;
};

/**
 * Compares what the plan asked for against what the run actually did.
 *
 * A planned job has to have succeeded. A job the plan skipped has to have been
 * skipped: if it ran anyway the plan and the workflow have drifted apart, and
 * that is worth failing on even when the job passed.
 */
export function verifyPlan(
  plan: TestPlan,
  workflow: string,
  results: Results,
  config?: PlanConfig,
): Check[] {
  const jobs = lookupWorkflow(plan, workflow).jobs;
  const gates = config?.workflows[workflow] ?? {};
  const checks: Check[] = [];

  for (const [job, jobPlan] of Object.entries(jobs)) {
    // The gate job is the one running this check, so it is never in `needs`.
    if (gates[job]?.gate) {
      continue;
    }

    const result = results[job]?.result ?? "missing";

    if (jobPlan.run) {
      checks.push({
        job,
        expected: "run",
        result,
        ok: result === "success",
        detail:
          result === "success"
            ? jobPlan.reason
            : result === "missing"
              ? "planned to run but is not in `needs` — wire it into the gate job"
              : `planned to run (${jobPlan.reason}) but ${result}`,
      });
      continue;
    }

    checks.push({
      job,
      expected: "skip",
      result,
      ok: result === "skipped" || result === "missing",
      detail:
        result === "skipped" || result === "missing"
          ? jobPlan.reason
          : `planned to be skipped (${jobPlan.reason}) but ${result}`,
    });
  }

  for (const job of Object.keys(results)) {
    if (!(job in jobs)) {
      checks.push({
        job,
        expected: "skip",
        result: results[job]?.result ?? "missing",
        ok: false,
        detail: `ran but is not in the plan — add it to .github/test-plan.yaml`,
      });
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stderr: "pipe" });

  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  }

  return result.stdout.toString();
}

type PullRequest = {
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  labels: { name: string }[];
};

/** A context, and a way to get the diff if it turns out to be needed. */
type Source = { context: PlanContext; diff: () => PlanDiff };

function pullRequestSource(
  number: string,
  repo: string | undefined,
  toDiff: (files: string[]) => PlanDiff,
  /** Extra labels to pretend the pull request carries, from --label. */
  extraLabels: string[],
): Source {
  const scope = repo ? ["--repo", repo] : [];
  const view = JSON.parse(
    run([
      "gh",
      "pr",
      "view",
      number,
      ...scope,
      "--json",
      "headRefName,baseRefName,isDraft,labels",
    ]),
  ) as PullRequest;

  return {
    context: {
      event: "pull_request",
      // The branch under test, which `branch` predicates match against — for
      // a pull request that is the head, not the branch it will merge into.
      ref: view.headRefName,
      baseRef: view.baseRefName,
      draft: view.isDraft,
      // The API is the source of truth, so a re-run picks up a label added
      // since the run started. --label adds to that, which is how you ask
      // "what would CI do if I labelled this?" without labelling it.
      labels: [
        ...new Set([...view.labels.map((label) => label.name), ...extraLabels]),
      ],
    },
    // A second round trip to the API, so it only happens when it has to.
    diff: () =>
      toDiff(
        run(["gh", "pr", "diff", number, ...scope, "--name-only"])
          .split("\n")
          .filter((line) => line.length > 0),
      ),
  };
}

function localSource(
  options: Options,
  toDiff: (files: string[]) => PlanDiff,
): Source {
  const head = one(options, "head") ?? "HEAD";
  // An empty --base is treated as absent, since that is what a workflow passes
  // for an event with no `before` at all. A base that is present but useless —
  // the all-zero commit a branch-creating push reports, say — is left alone on
  // purpose: the diff against it fails, and everything runs.
  const base = one(options, "base") || defaultBase(head);
  const ref =
    one(options, "ref") ??
    run(["git", "rev-parse", "--abbrev-ref", head]).trim();

  return {
    context: {
      event: one(options, "event") ?? "push",
      ref,
      baseRef: one(options, "base-ref") ?? null,
      draft: false,
      labels: many(options, "label"),
    },
    diff: () => toDiff(changedFiles(base, head)),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export type Options = Record<string, string[]>;

export function parseArgs(argv: string[]): Options {
  const options: Options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === undefined || !arg.startsWith("--")) {
      throw new Error(`expected a --flag, got "${arg}"`);
    }

    const [flag, inlineValue] = splitFlag(arg.slice(2));
    const value = inlineValue ?? argv[++i];

    if (value === undefined) {
      throw new Error(`--${flag} needs a value`);
    }

    const existing = options[flag] ?? [];

    existing.push(value);
    options[flag] = existing;
  }

  return options;
}

function splitFlag(flag: string): [string, string | undefined] {
  const equals = flag.indexOf("=");

  return equals === -1
    ? [flag, undefined]
    : [flag.slice(0, equals), flag.slice(equals + 1)];
}

function one(options: Options, flag: string): string | undefined {
  const values = options[flag];

  if (values && values.length > 1) {
    throw new Error(`--${flag} was given more than once`);
  }

  return values?.[0];
}

/** Every value given for a repeatable flag, in the order they were given. */
function many(options: Options, flag: string): string[] {
  return options[flag] ?? [];
}

function required(options: Options, flag: string): string {
  const value = one(options, flag);

  if (value === undefined) {
    throw new Error(`--${flag} is required`);
  }

  return value;
}

async function readSource(location: string): Promise<string> {
  return location === "-"
    ? await Bun.stdin.text()
    : await Bun.file(location).text();
}

/** Job outputs survive newlines only via the heredoc form. */
async function writeOutput(name: string, value: string): Promise<void> {
  const path = process.env.GITHUB_OUTPUT;

  if (!path) {
    return;
  }

  const delimiter = `EOF_${crypto.randomUUID().replaceAll("-", "")}`;
  const block = `${name}<<${delimiter}\n${value}\n${delimiter}\n`;

  await Bun.write(path, (await Bun.file(path).text()) + block);
}

async function appendSummary(markdown: string): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;

  if (!path) {
    return;
  }

  await Bun.write(path, (await Bun.file(path).text()) + markdown);
}

/** What the diff said, or why the plan has none to show. */
function describeChanges(plan: TestPlan): string {
  const { changedFiles, changedGroups } = plan.inputs;

  if (changedGroups === null) {
    return `(no diff — ${plan.override} decides)`;
  }

  return `${changedGroups.join(", ") || "(no matching groups)"} (${changedFiles?.length ?? 0} file(s))`;
}

function describePlan(plan: TestPlan): string {
  const lines: string[] = [];
  const { inputs } = plan;

  lines.push(`event:    ${inputs.event}`);
  lines.push(
    `ref:      ${inputs.ref}${inputs.baseRef ? ` -> ${inputs.baseRef}` : ""}`,
  );
  lines.push(`labels:   ${inputs.labels.join(", ") || "(none)"}`);
  lines.push(`changed:  ${describeChanges(plan)}`);
  lines.push(`override: ${plan.override ?? "(none)"}`);
  lines.push("");

  for (const [workflow, workflowPlan] of Object.entries(plan.workflows)) {
    lines.push(`${workflowPlan.run ? "RUN " : "SKIP"} ${workflow}`);

    for (const [job, jobPlan] of Object.entries(workflowPlan.jobs)) {
      lines.push(
        `  ${jobPlan.run ? "RUN " : "SKIP"} ${job.padEnd(12)} ${jobPlan.reason}`,
      );
    }
  }

  return lines.join("\n");
}

async function createCommand(options: Options): Promise<number> {
  const configPath = one(options, "config") ?? ".github/test-plan.yaml";
  const filtersPath = one(options, "filters") ?? ".github/paths-filter.yaml";

  const config = parseConfig(await Bun.file(configPath).text());
  const filters = parseFilters(await Bun.file(filtersPath).text());

  validateGroups(config, Object.keys(filters));

  const toDiff = (files: string[]): PlanDiff => ({
    changedFiles: files,
    changedGroups: matchGroups(filters, files),
  });

  const pr = one(options, "pr");
  const { context, diff } = pr
    ? pullRequestSource(
        pr,
        one(options, "repo"),
        toDiff,
        many(options, "label"),
      )
    : localSource(options, toDiff);

  const plan = createPlan(config, context, diff);
  const json = serializePlan(plan);

  if (one(options, "format") !== "json") {
    console.log(describePlan(plan));
  } else {
    console.log(json);
  }

  const out = one(options, "out");

  if (out) {
    await Bun.write(out, `${json}\n`);
  }

  await writeOutput("plan", json);
  await appendSummary(
    `## Test plan\n\n\`\`\`\n${describePlan(plan)}\n\`\`\`\n`,
  );

  return 0;
}

async function executeCommand(options: Options): Promise<number> {
  const plan = parsePlan(await readSource(required(options, "plan")));
  const workflow = required(options, "workflow");
  const job = one(options, "job");

  const decision = job
    ? lookupJob(plan, workflow, job)
    : lookupWorkflow(plan, workflow);
  const reason = "reason" in decision ? decision.reason : "any job runs";

  console.log(String(decision.run));
  console.error(
    `${workflow}${job ? `/${job}` : ""}: ${decision.run ? "run" : "skip"} (${reason})`,
  );

  await writeOutput("run", String(decision.run));

  return 0;
}

async function verifyCommand(options: Options): Promise<number> {
  const configPath = one(options, "config") ?? ".github/test-plan.yaml";
  const config = parseConfig(await Bun.file(configPath).text());

  const plan = parsePlan(await readSource(required(options, "plan")));
  const workflow = required(options, "workflow");

  const resultsSource =
    one(options, "results") ??
    (await readSource(required(options, "results-file")));
  const checks = verifyPlan(
    plan,
    workflow,
    JSON.parse(resultsSource) as Results,
    config,
  );

  const lines = checks.map(
    (check) =>
      `${check.ok ? "PASS" : "FAIL"} ${check.job.padEnd(12)} ${check.result.padEnd(9)} ${check.detail}`,
  );
  const failed = checks.filter((check) => !check.ok);

  console.log(lines.join("\n"));
  console.log(
    failed.length === 0
      ? `\nAll ${checks.length} job(s) matched the plan.`
      : `\n${failed.length} of ${checks.length} job(s) did not match the plan.`,
  );

  await appendSummary(
    `## Required check\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`,
  );

  return failed.length === 0 ? 0 : 1;
}

/**
 * A command, and everything `--help` says about it. Keeping the help next to
 * the handler is what stops the two drifting apart: a new flag that goes
 * undocumented is visible in the same object it was added to.
 */
export type Command = {
  run: (options: Options) => Promise<number>;
  /** One line, for the command list in the top-level help. */
  summary: string;
  /** What follows `test-plan.ts <name>` in the usage line. */
  args: string;
  /** A paragraph or two on what the command is for, wrapped at 76 columns. */
  description: string[];
  /** Every flag the command reads, with its default where it has one. */
  flags: [flag: string, description: string][];
  /** Worked invocations, the kind you would actually type. */
  examples: string[];
};

export const COMMANDS: Record<string, Command> = {
  create: {
    run: createCommand,
    summary: "work out which workflows and jobs should run",
    args: "[--pr <n> | --event <e> --ref <r>] [options]",
    description: [
      "Resolves its inputs from a pull request (--pr, via gh) or from the",
      "flags and the local git repository, so the same command run on a",
      "laptop and in CI produces the same plan. Prints the plan, and writes",
      "it to the `plan` job output when GITHUB_OUTPUT is set.",
    ],
    flags: [
      ["--pr <n>", "plan pull request <n>: its branch, draft state and labels"],
      ["--repo <owner/name>", "repository --pr belongs to (default: current)"],
      ["--event <name>", "event to plan for, without --pr (default: push)"],
      ["--ref <name>", "branch under test (default: the branch at --head)"],
      [
        "--base <ref>",
        "what to diff against (default: the commit before --head)",
      ],
      ["--head <ref>", "what to diff (default: HEAD)"],
      ["--base-ref <name>", "branch being merged into, recorded in the plan"],
      ["--label <name>", "add a label to the context; repeatable"],
      ["--config <path>", "plan config (default: .github/test-plan.yaml)"],
      ["--filters <path>", "path groups (default: .github/paths-filter.yaml)"],
      ["--out <path>", "also write the plan JSON to <path>"],
      ["--format json|text", "how to print the plan (default: text)"],
    ],
    examples: [
      "test-plan.ts create --pr 9",
      "test-plan.ts create --pr 9 --label force-run",
      "test-plan.ts create --event push --ref main --format json",
      "test-plan.ts create --base origin/main --head HEAD --out plan.json",
    ],
  },
  execute: {
    run: executeCommand,
    summary: "ask the plan whether one workflow or job runs",
    args: "--plan <path|-> --workflow <w> [--job <j>]",
    description: [
      "Prints `true` or `false` on stdout and the reason on stderr, and",
      "writes the answer to the `run` job output when GITHUB_OUTPUT is set.",
      "Without --job it answers for the workflow as a whole.",
    ],
    flags: [
      ["--plan <path|->", "the plan, as a file or `-` for stdin"],
      ["--workflow <name>", "the workflow to ask about"],
      ["--job <name>", "a job inside it (default: the workflow itself)"],
    ],
    examples: [
      "test-plan.ts execute --plan plan.json --workflow ci",
      "test-plan.ts execute --plan - --workflow lint --job lint",
    ],
  },
  verify: {
    run: verifyCommand,
    summary: "check a finished run did what the plan asked for",
    args: "--plan <path|-> --workflow <w> (--results <json> | --results-file <path|->)",
    description: [
      "The required check. Takes the plan and the `needs` context and",
      "confirms every job the plan asked for ran and passed, and every job",
      "it ruled out was skipped. Exits non-zero when they disagree.",
    ],
    flags: [
      ["--plan <path|->", "the plan, as a file or `-` for stdin"],
      ["--workflow <name>", "the workflow whose jobs to check"],
      ["--results <json>", "the `needs` context, as JSON"],
      ["--results-file <path|->", "the same, read from a file or stdin"],
      ["--config <path>", "plan config (default: .github/test-plan.yaml)"],
    ],
    examples: [
      'test-plan.ts verify --plan plan.json --workflow ci --results "$RESULTS"',
      "printf '%s' \"$PLAN\" | test-plan.ts verify --plan - --workflow ci \\",
      "  --results-file results.json",
    ],
  },
};

/** The command list, for `--help` with no command given. */
function overviewHelp(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));

  return [
    "test-plan.ts — build and read the CI test plan.",
    "",
    "usage: test-plan.ts <command> [options]",
    "",
    "commands:",
    ...Object.entries(COMMANDS).map(
      ([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`,
    ),
    "",
    "Run `test-plan.ts <command> --help` for a command's options.",
  ].join("\n");
}

/** Everything about one command, for `<command> --help`. */
function commandHelp(name: string): string {
  const command = COMMANDS[name] as Command;
  const width = Math.max(...command.flags.map(([flag]) => flag.length));

  return [
    `test-plan.ts ${name} — ${command.summary}.`,
    "",
    `usage: test-plan.ts ${name} ${command.args}`,
    "",
    ...command.description,
    "",
    "options:",
    ...command.flags.map(
      ([flag, description]) => `  ${flag.padEnd(width)}  ${description}`,
    ),
    "",
    "examples:",
    ...command.examples.map((example) => `  ${example}`),
  ].join("\n");
}

/** `--help` and `-h` take no value, so they never reach parseArgs. */
function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

async function main(): Promise<number> {
  const [command, ...rest] = Bun.argv.slice(2);

  // `help`, `help <command>`, `--help`, `-h` — all the spellings people try.
  if (command === "help" || command === undefined || wantsHelp([command])) {
    const topic = command === "help" ? rest[0] : undefined;

    if (topic !== undefined && !(topic in COMMANDS)) {
      console.error(`unknown command "${topic}"\n\n${overviewHelp()}`);
      return 2;
    }

    // No arguments at all is a misuse rather than a question, so the help
    // goes to stderr and the exit code says something was wrong.
    if (command === undefined) {
      console.error(overviewHelp());
      return 2;
    }

    console.log(topic === undefined ? overviewHelp() : commandHelp(topic));
    return 0;
  }

  if (!(command in COMMANDS)) {
    console.error(`unknown command "${command}"\n\n${overviewHelp()}`);
    return 2;
  }

  if (wantsHelp(rest)) {
    console.log(commandHelp(command));
    return 0;
  }

  return await (COMMANDS[command] as Command).run(parseArgs(rest));
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
