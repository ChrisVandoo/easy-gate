import { describe, expect, test } from "bun:test";
import { parseFilters } from "./paths-filter.ts";
import {
  COMMANDS,
  createPlan,
  DIFF_FAILED,
  lookupJob,
  matchesPredicate,
  type PlanContext,
  parseArgs,
  parseConfig,
  parsePlan,
  serializePlan,
  validateGroups,
  verifyPlan,
} from "./test-plan.ts";

const config = parseConfig(`
overrides:
  - id: skip-all
    when:
      labels: [skip-all]
    decision: skip
    reason: skip-all label is set
  - id: force-run
    when:
      labels: [force-run]
    decision: run
    reason: force-run label is set
  - id: protected-branch
    when:
      branch: [main, "release/**"]
    decision: run
    reason: pushes to a protected branch always run everything

workflows:
  ci:
    jobs:
      plan:
        exempt: true
      lint:
        paths: [src, workflows]
      test:
        paths: [src]
        when:
          - labels: [deep-test]
          - branch: ["release/**"]
      required:
        gate: true
`);

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    event: "pull_request",
    ref: "feature",
    baseRef: "main",
    draft: false,
    labels: [],
    ...overrides,
  };
}

/** Builds a plan, and notes whether working the diff out was ever needed. */
function build(
  overrides: Partial<PlanContext> = {},
  /** The groups the diff reports, or the error it fails with. */
  changed: string[] | Error = [],
) {
  let askedForDiff = false;

  const plan = createPlan(config, context(overrides), () => {
    askedForDiff = true;

    if (changed instanceof Error) {
      throw changed;
    }

    return {
      changedFiles: changed.map((group) => `${group}/file.ts`),
      changedGroups: changed,
    };
  });

  return { plan, askedForDiff };
}

function jobs(plan: ReturnType<typeof createPlan>): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(plan.workflows.ci?.jobs ?? {}).map(([job, jobPlan]) => [
      job,
      jobPlan.run,
    ]),
  );
}

describe("parseConfig", () => {
  test("reads overrides in order", () => {
    expect(config.overrides.map((override) => override.id)).toEqual([
      "skip-all",
      "force-run",
      "protected-branch",
    ]);
  });

  test("reads job options", () => {
    expect(config.workflows.ci?.test).toEqual({
      paths: ["src"],
      when: [{ labels: ["deep-test"] }, { branch: ["release/**"] }],
      exempt: false,
      gate: false,
    });
  });

  test("rejects a job `when` that is not a list", () => {
    expect(() =>
      parseConfig(
        "workflows:\n  ci:\n    jobs:\n      test:\n        when:\n          labels: [x]",
      ),
    ).toThrow(/must be a list of `when` mappings/);
  });

  test("rejects an override without a decision", () => {
    expect(() =>
      parseConfig("overrides:\n  - id: x\n    when: {}\nworkflows: {}"),
    ).toThrow(/decision: run \| skip/);
  });

  test("rejects a workflow without jobs", () => {
    expect(() => parseConfig("workflows:\n  ci: {}")).toThrow(/`jobs` mapping/);
  });
});

describe("matchesPredicate", () => {
  test("matches any of the listed labels", () => {
    expect(
      matchesPredicate({ labels: ["a", "b"] }, context({ labels: ["b"] })),
    ).toBe(true);
  });

  test("matches a branch by name", () => {
    const when = { branch: ["main"] };

    expect(matchesPredicate(when, context({ ref: "main" }))).toBe(true);
    expect(matchesPredicate(when, context({ ref: "mainly" }))).toBe(false);
  });

  test("matches a branch by glob", () => {
    const when = { branch: ["release/*", "renovate/**"] };

    expect(matchesPredicate(when, context({ ref: "release/1.2" }))).toBe(true);
    // `*` stops at a slash, `**` does not.
    expect(matchesPredicate(when, context({ ref: "release/1.2/fix" }))).toBe(
      false,
    );
    expect(matchesPredicate(when, context({ ref: "renovate/a/b" }))).toBe(true);
    expect(matchesPredicate(when, context({ ref: "feature" }))).toBe(false);
  });

  test("matches a label by glob", () => {
    expect(
      matchesPredicate({ labels: ["ci/*"] }, context({ labels: ["ci/skip"] })),
    ).toBe(true);
  });

  test("matches a pull request on its head branch, not its base", () => {
    // A pull request into main is still a pull request, so the branch
    // override must not fire on it.
    expect(
      matchesPredicate({ branch: ["main"] }, context({ baseRef: "main" })),
    ).toBe(false);
  });

  test("ands its predicates together", () => {
    const when = { labels: ["a"], event: ["push"] };

    expect(
      matchesPredicate(when, context({ labels: ["a"], event: "push" })),
    ).toBe(true);
    expect(matchesPredicate(when, context({ labels: ["a"] }))).toBe(false);
  });

  test("never matches on an empty `when`", () => {
    expect(matchesPredicate({}, context())).toBe(false);
  });

  test("rejects an unknown predicate", () => {
    expect(() => matchesPredicate({ phase: "moon" }, context())).toThrow(
      /unknown predicate "phase"/,
    );
  });
});

describe("createPlan", () => {
  test("filters on changed paths", () => {
    const { plan } = build({}, ["workflows"]);

    expect(jobs(plan)).toEqual({
      plan: true,
      lint: true,
      test: false,
      required: true,
    });
    expect(plan.workflows.ci?.jobs.test?.reason).toBe("no changes in src");
  });

  test("runs nothing when no group is touched", () => {
    const { plan } = build();

    expect(jobs(plan)).toEqual({
      plan: true,
      lint: false,
      test: false,
      required: true,
    });
  });

  test("runs everything on a protected branch", () => {
    const { plan, askedForDiff } = build({ event: "push", ref: "main" });

    expect(plan.override).toBe("protected-branch");
    // The override settles every job, so there is nothing for a diff to tell
    // us — and on the default branch that diff is the most expensive one.
    expect(askedForDiff).toBe(false);
    expect(plan.inputs.changedGroups).toBeNull();
    expect(jobs(plan)).toEqual({
      plan: true,
      lint: true,
      test: true,
      required: true,
    });
  });

  test("runs everything when the diff cannot be worked out", () => {
    // A new branch, a force-pushed base, a clone too shallow to reach it: the
    // diff is unavailable, which is not the same as empty. Skipping jobs here
    // would be skipping them on no evidence.
    const { plan, askedForDiff } = build(
      { event: "push" },
      new Error("fatal: bad object 0000000"),
    );

    expect(plan.override).toBe(DIFF_FAILED);
    expect(askedForDiff).toBe(true);
    expect(jobs(plan)).toEqual({
      plan: true,
      lint: true,
      test: true,
      required: true,
    });
  });

  test("records that the diff was unavailable", () => {
    const { plan } = build({}, new Error("fatal: bad object 0000000"));

    expect(plan.inputs.changedGroups).toBeNull();
    expect(plan.workflows.ci?.jobs.test?.reason).toMatch(/everything runs/);
  });

  test("an override settles it before the diff gets a chance to fail", () => {
    const { plan, askedForDiff } = build(
      { labels: ["skip-all"] },
      new Error("fatal: bad object 0000000"),
    );

    expect(plan.override).toBe("skip-all");
    expect(askedForDiff).toBe(false);
    expect(jobs(plan).test).toBe(false);
  });

  test("force-run beats an empty diff", () => {
    const { plan } = build({ labels: ["force-run"] });

    expect(jobs(plan).test).toBe(true);
  });

  test("skip-all beats a diff that would otherwise run jobs", () => {
    const { plan } = build({ labels: ["skip-all"] }, ["src", "workflows"]);

    expect(jobs(plan)).toEqual({
      plan: true,
      lint: false,
      test: false,
      // The required check still runs, so a skip-all pull request is mergeable.
      required: true,
    });
  });

  test("skip-all wins over force-run, since it is listed first", () => {
    const { plan } = build({ labels: ["force-run", "skip-all"] });

    expect(plan.override).toBe("skip-all");
  });

  test("a job runs when its own `when` matches, whatever the diff says", () => {
    const { plan } = build({ labels: ["deep-test"] });

    expect(jobs(plan).test).toBe(true);
    expect(lookupJob(plan, "ci", "test").reason).toBe(
      "asked for by labels: deep-test",
    );
    // Only the job that asked for it — this is not another blanket override.
    expect(jobs(plan).lint).toBe(false);
  });

  test("a job's `when` is an or, so any one entry is enough", () => {
    expect(jobs(build({ ref: "release/1.2", labels: [] }).plan).test).toBe(
      true,
    );
    expect(jobs(build({ ref: "feature" }).plan).test).toBe(false);
  });

  test("asking for a job by label outranks skip-all", () => {
    const { plan } = build({ labels: ["skip-all", "deep-test"] });

    expect(plan.override).toBe("skip-all");
    expect(jobs(plan)).toEqual({
      plan: true,
      lint: false,
      test: true,
      required: true,
    });
  });

  test("a `when` that does not match leaves the path filter alone", () => {
    expect(jobs(build({ labels: ["unrelated"] }, ["src"]).plan).test).toBe(
      true,
    );
    expect(
      jobs(build({ labels: ["unrelated"] }, ["workflows"]).plan).test,
    ).toBe(false);
  });

  test("a job's `when` still does not make the diff worth working out", () => {
    // The diff decides the other jobs, so it is still asked for — the point is
    // that a label does not stand in for it.
    const { askedForDiff } = build({ labels: ["deep-test"] });

    expect(askedForDiff).toBe(true);
  });

  test("a workflow runs when any of its real jobs run", () => {
    expect(build({}, ["src"]).plan.workflows.ci?.run).toBe(true);
    // plan and required still run, but neither is real work.
    expect(build().plan.workflows.ci?.run).toBe(false);
  });
});

describe("createPlan with a called workflow", () => {
  const nested = parseConfig(`
overrides:
  - id: skip-all
    when:
      labels: [skip-all]
    decision: skip
    reason: skip-all label is set

workflows:
  ci:
    jobs:
      plan:
        exempt: true
      test:
        calls: test
      required:
        gate: true
  test:
    jobs:
      unit:
        paths: [src]
      docs:
        paths: [workflows]
      verify:
        gate: true
`);

  function planNested(changed: string[], labels: string[] = []) {
    return createPlan(nested, context({ labels }), () => ({
      changedFiles: changed.map((group) => `${group}/file.ts`),
      changedGroups: changed,
    }));
  }

  test("filters the called workflow's jobs in their own right", () => {
    const plan = planNested(["src"]);

    expect(lookupJob(plan, "test", "unit").run).toBe(true);
    expect(lookupJob(plan, "test", "docs").run).toBe(false);
  });

  test("the calling job runs when the called workflow has work in it", () => {
    const plan = planNested(["workflows"]);

    expect(lookupJob(plan, "ci", "test")).toEqual({
      run: true,
      reason: "the test workflow has jobs to run",
    });
  });

  test("the calling job is skipped when every nested job is", () => {
    const plan = planNested([]);

    expect(lookupJob(plan, "ci", "test")).toEqual({
      run: false,
      reason: "nothing to run in the test workflow",
    });
    // ...which is the whole point: the nested filter reaches the caller, so no
    // runner is spent starting a workflow with nothing to do.
    expect(plan.workflows.ci?.run).toBe(false);
  });

  test("an override reaches the nested jobs, and so the caller", () => {
    const plan = planNested(["src"], ["skip-all"]);

    expect(lookupJob(plan, "test", "unit").run).toBe(false);
    expect(lookupJob(plan, "ci", "test").run).toBe(false);
    // The gates still run, so the required check stays green.
    expect(lookupJob(plan, "test", "verify").run).toBe(true);
  });

  test("a gate of its own does not make a workflow worth calling", () => {
    expect(planNested(["workflows"]).workflows.test?.run).toBe(true);
    expect(planNested([]).workflows.test?.run).toBe(false);
  });

  test("rejects a call to a workflow that cannot verify itself", () => {
    expect(() =>
      parseConfig(`
workflows:
  ci:
    jobs:
      test:
        calls: test
  test:
    jobs:
      unit:
        paths: [src]
`),
    ).toThrow(/needs a `gate` job of its own/);
  });

  test("rejects a call to a workflow that is not described", () => {
    expect(() =>
      parseConfig(
        "workflows:\n  ci:\n    jobs:\n      test:\n        calls: nope",
      ),
    ).toThrow(/not described here/);
  });

  test("rejects options sitting beside a call", () => {
    expect(() =>
      parseConfig(
        "workflows:\n  ci:\n    jobs:\n      test:\n        calls: test\n        paths: [src]",
      ),
    ).toThrow(/cannot combine `calls` with paths/);
  });

  test("rejects a workflow that ends up calling itself", () => {
    const cyclic = {
      overrides: [],
      workflows: {
        a: { call: { calls: "b" }, verify: { gate: true } },
        b: { call: { calls: "a" }, verify: { gate: true } },
      },
    };

    expect(() =>
      createPlan(cyclic, context(), () => ({
        changedFiles: [],
        changedGroups: [],
      })),
    ).toThrow(/ends up calling itself: a -> b -> a/);
  });
});

describe("serializePlan", () => {
  /** A plan whose `changedFiles` is `count` long, which is the only part of a
   * plan that grows without bound. */
  function planOf(count: number) {
    return createPlan(config, context(), () => ({
      changedFiles: Array.from(
        { length: count },
        (_, i) => `src/generated/file-${i}.ts`,
      ),
      changedGroups: ["src"],
    }));
  }

  test("round-trips a plan of ordinary size", () => {
    // One plan, not two: `createdAt` is stamped per call.
    const plan = planOf(20);

    expect(parsePlan(serializePlan(plan))).toEqual(plan);
  });

  test("refuses a plan too big for CI to pass between jobs", () => {
    // Over 1 MB of file names, which is what a job output can carry.
    expect(() => serializePlan(planOf(60_000))).toThrow(
      /over the 1024 KB a job output can carry/,
    );
  });

  test("reports both sizes, so it is clear how far over it is", () => {
    expect(() => serializePlan(planOf(100), 1024)).toThrow(
      /The plan is [\d.]+ KB, over the 1.0 KB/,
    );
  });

  test("lets a plan exactly at the limit through", () => {
    const plan = planOf(10);
    const bytes = new TextEncoder().encode(serializePlan(plan)).length;

    expect(() => serializePlan(plan, bytes)).not.toThrow();
    expect(() => serializePlan(plan, bytes - 1)).toThrow();
  });
});

describe("parsePlan", () => {
  test("rejects an empty plan", () => {
    expect(() => parsePlan("  ")).toThrow(/plan is empty/);
  });

  test("rejects a plan from a different version", () => {
    expect(() => parsePlan(`{"version":99}`)).toThrow(/version 99/);
  });
});

describe("lookupJob", () => {
  const { plan } = build({}, ["src"]);

  test("finds a job", () => {
    expect(lookupJob(plan, "ci", "test").run).toBe(true);
  });

  test("names the jobs it does know about", () => {
    expect(() => lookupJob(plan, "ci", "nope")).toThrow(/only plan, lint/);
  });

  test("rejects an unknown workflow", () => {
    expect(() => lookupJob(plan, "nope", "test")).toThrow(/no workflow "nope"/);
  });
});

describe("verifyPlan", () => {
  const { plan } = build({}, ["workflows"]);

  const check = (results: Record<string, { result?: string }>) =>
    Object.fromEntries(
      verifyPlan(plan, "ci", results, config).map((result) => [
        result.job,
        result.ok,
      ]),
    );

  test("passes when the run matches the plan", () => {
    expect(
      check({
        plan: { result: "success" },
        lint: { result: "success" },
        test: { result: "skipped" },
      }),
    ).toEqual({ plan: true, lint: true, test: true });
  });

  test("fails a planned job that did not succeed", () => {
    expect(
      check({
        plan: { result: "success" },
        lint: { result: "failure" },
        test: { result: "skipped" },
      }).lint,
    ).toBe(false);
  });

  test("fails a planned job that never appeared in `needs`", () => {
    const [result] = verifyPlan(
      plan,
      "ci",
      { plan: { result: "success" }, test: { result: "skipped" } },
      config,
    ).filter((entry) => entry.job === "lint");

    expect(result?.ok).toBe(false);
    expect(result?.detail).toMatch(/not in `needs`/);
  });

  test("fails a job that ran although the plan skipped it", () => {
    expect(
      check({
        plan: { result: "success" },
        lint: { result: "success" },
        test: { result: "success" },
      }).test,
    ).toBe(false);
  });

  test("fails a job that ran but is not in the plan at all", () => {
    expect(
      check({
        plan: { result: "success" },
        lint: { result: "success" },
        test: { result: "skipped" },
        stray: { result: "success" },
      }).stray,
    ).toBe(false);
  });

  test("never expects the gate job itself, which is doing the checking", () => {
    expect(
      verifyPlan(plan, "ci", { plan: { result: "success" } }, config).map(
        (entry) => entry.job,
      ),
    ).not.toContain("required");
  });

  test("passes a skip-all run, so the required check stays green", () => {
    const { plan: skipped } = build({ labels: ["skip-all"] });

    expect(
      verifyPlan(
        skipped,
        "ci",
        {
          plan: { result: "success" },
          lint: { result: "skipped" },
          test: { result: "skipped" },
        },
        config,
      ).every((entry) => entry.ok),
    ).toBe(true);
  });
});

// The plan is only trustworthy if it describes the workflows that actually
// exist, so check the real files against each other rather than waiting for a
// run to fail.
type WorkflowFile = {
  jobs: Record<string, { needs?: string | string[]; uses?: string }>;
};

const realConfig = parseConfig(await Bun.file(".github/test-plan.yaml").text());
const realFilters = parseFilters(
  await Bun.file(".github/paths-filter.yaml").text(),
);
const realWorkflows = Object.fromEntries(
  await Promise.all(
    Object.keys(realConfig.workflows).map(async (name) => [
      name,
      Bun.YAML.parse(
        await Bun.file(`.github/workflows/${name}.yml`).text(),
      ) as WorkflowFile,
    ]),
  ),
) as Record<string, WorkflowFile>;

describe("the checked-in config", () => {
  test("every path group it filters on exists", () => {
    expect(() =>
      validateGroups(realConfig, Object.keys(realFilters)),
    ).not.toThrow();
  });

  test.each(Object.keys(realConfig.workflows))(
    "%s has exactly the jobs the plan names",
    (name) => {
      expect(Object.keys(realWorkflows[name]?.jobs ?? {}).sort()).toEqual(
        Object.keys(realConfig.workflows[name] ?? {}).sort(),
      );
    },
  );

  // Every workflow that verifies itself, which is every workflow with a gate:
  // ci, and each workflow ci calls.
  test.each(
    Object.keys(realConfig.workflows).filter((name) =>
      Object.values(realConfig.workflows[name] ?? {}).some(
        (options) => options.gate,
      ),
    ),
  )("%s's gate job needs every job it has to verify", (name) => {
    const jobs = realConfig.workflows[name] ?? {};
    const gate = Object.keys(jobs).find((job) => jobs[job]?.gate);
    const needs = realWorkflows[name]?.jobs[gate ?? ""]?.needs ?? [];

    expect(gate).toBeDefined();
    expect([needs].flat().sort()).toEqual(
      Object.keys(jobs)
        .filter((job) => !jobs[job]?.gate)
        .sort(),
    );
  });

  // A `calls` that names the wrong workflow would plan one workflow and gate
  // another, and both would look fine on their own.
  test("every `calls` job really is a call, to the workflow it names", () => {
    for (const [name, jobs] of Object.entries(realConfig.workflows)) {
      for (const [job, options] of Object.entries(jobs)) {
        if (options.calls === undefined) {
          continue;
        }

        expect(realWorkflows[name]?.jobs[job]?.uses).toBe(
          `./.github/workflows/${options.calls}.yml`,
        );
      }
    }
  });

  test("it plans, so nothing in it calls a workflow that is not there", () => {
    expect(() =>
      createPlan(realConfig, context(), () => ({
        changedFiles: [],
        changedGroups: [],
      })),
    ).not.toThrow();
  });
});

const cliSource = await Bun.file(".github/scripts/test-plan.ts").text();

// The help is only worth having if it is true, and it stops being true the
// moment someone reads a flag the help does not mention.
describe("the CLI help", () => {
  const documented = new Set(
    Object.values(COMMANDS).flatMap((command) =>
      command.flags.map(([flag]) => flag.split(" ")[0]?.slice(2)),
    ),
  );

  test("every flag the script reads is documented", () => {
    const read = [
      ...cliSource.matchAll(/(?:one|required|many)\(options, "([a-z-]+)"\)/g),
    ].map((match) => match[1] as string);

    expect([...new Set(read)].filter((flag) => !documented.has(flag))).toEqual(
      [],
    );
  });

  test.each(Object.keys(COMMANDS))("%s's examples parse", (name) => {
    for (const example of COMMANDS[name]?.examples ?? []) {
      // Only the lines that are a whole invocation; a continued line is
      // checked as part of the one it continues.
      if (!example.startsWith(`test-plan.ts ${name}`)) {
        continue;
      }

      const argv = example
        .replace(`test-plan.ts ${name} `, "")
        .replaceAll("\\", "")
        .split(/\s+/)
        .filter((word) => word.length > 0);

      expect(() => parseArgs(argv)).not.toThrow();
      expect(
        Object.keys(parseArgs(argv)).filter((flag) => !documented.has(flag)),
      ).toEqual([]);
    }
  });
});
