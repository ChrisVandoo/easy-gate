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
 * Usage:
 *   test-plan.ts create  [--pr <n>] [--event <e>] [--ref <r>] [--label <l>]...
 *                        [--base <ref>] [--head <ref>]
 *                        [--repo <owner/name>] [--config <p>] [--filters <p>]
 *                        [--out <path>] [--format json|text]
 *   test-plan.ts execute --plan <path|-> --workflow <w> [--job <j>]
 *   test-plan.ts verify  --plan <path|-> --workflow <w> --results <json>
 *
 * `create` resolves its inputs from a pull request (--pr, via gh) or from the
 * flags directly, so the same command run on a laptop and in CI produces the
 * same plan. `execute` answers a single should-this-run question. `verify` is
 * the required check: it takes the plan and the `needs` context and confirms
 * every job the plan asked for actually ran and passed.
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
        paths: options.paths as string[] | undefined,
        when: parseJobWhen(options.when, `${workflow}/${job}`),
        exempt: options.exempt === true,
        gate: options.gate === true,
      };
    }

    workflows[workflow] = jobs;
  }

  return { overrides, workflows };
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

  const workflows: Record<string, WorkflowPlan> = {};

  for (const [workflow, jobConfigs] of Object.entries(config.workflows)) {
    const jobs: Record<string, JobPlan> = {};

    for (const [job, options] of Object.entries(jobConfigs)) {
      jobs[job] = planJob(
        options,
        context,
        override,
        changes?.changedGroups ?? [],
      );
    }

    // A workflow is worth running when it has real work in it — a gate or an
    // exempt bookkeeping job on its own does not count.
    workflows[workflow] = {
      run: Object.entries(jobs).some(
        ([job, plan]) =>
          plan.run && !jobConfigs[job]?.gate && !jobConfigs[job]?.exempt,
      ),
      jobs,
    };
  }

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
      labels: options.label ?? [],
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
    ? pullRequestSource(pr, one(options, "repo"), toDiff, options.label ?? [])
    : localSource(options, toDiff);

  const plan = createPlan(config, context, diff);
  const json = JSON.stringify(plan);

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

const COMMANDS: Record<string, (options: Options) => Promise<number>> = {
  create: createCommand,
  execute: executeCommand,
  verify: verifyCommand,
};

async function main(): Promise<number> {
  const [command, ...rest] = Bun.argv.slice(2);

  if (command === undefined || !(command in COMMANDS)) {
    console.error(
      `usage: test-plan.ts <${Object.keys(COMMANDS).join("|")}> [options]`,
    );
    return 2;
  }

  return await (COMMANDS[command] as (o: Options) => Promise<number>)(
    parseArgs(rest),
  );
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
