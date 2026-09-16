import { describe, expect, test } from "bun:test";
import { parseFilters } from "./paths-filter.ts";
import {
  createPlan,
  lookupJob,
  matchesPredicate,
  type PlanContext,
  parseConfig,
  parsePlan,
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
  - id: first-commit
    when:
      firstCommit: true
    decision: run
    reason: nothing to diff against, so everything runs
  - id: default-branch
    when:
      defaultBranch: true
    decision: run
    reason: pushes to the default branch always run everything

workflows:
  ci:
    jobs:
      plan:
        exempt: true
      lint:
        paths: [src, workflows]
      test:
        paths: [src]
      required:
        gate: true
`);

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    event: "pull_request",
    ref: "feature",
    baseRef: "main",
    defaultBranch: false,
    firstCommit: false,
    draft: false,
    labels: [],
    ...overrides,
  };
}

/** Builds a plan, and notes whether working the diff out was ever needed. */
function build(
  overrides: Partial<PlanContext> = {},
  changedGroups: string[] = [],
) {
  let askedForDiff = false;

  const plan = createPlan(config, context(overrides), () => {
    askedForDiff = true;

    return {
      changedFiles: changedGroups.map((group) => `${group}/file.ts`),
      changedGroups,
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
      "first-commit",
      "default-branch",
    ]);
  });

  test("reads job options", () => {
    expect(config.workflows.ci?.test).toEqual({
      paths: ["src"],
      exempt: false,
      gate: false,
    });
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

  test("runs everything on the default branch", () => {
    const { plan, askedForDiff } = build({
      event: "push",
      ref: "main",
      defaultBranch: true,
    });

    expect(plan.override).toBe("default-branch");
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

  test("runs everything when there is no base to diff against", () => {
    // A new branch, or a root commit: the diff is empty because there is
    // nothing to compare to, not because nothing changed.
    const { plan, askedForDiff } = build({ event: "push", firstCommit: true });

    expect(plan.override).toBe("first-commit");
    expect(askedForDiff).toBe(false);
    expect(jobs(plan)).toEqual({
      plan: true,
      lint: true,
      test: true,
      required: true,
    });
  });

  test("skip-all still wins on a first commit", () => {
    expect(
      build({ firstCommit: true, labels: ["skip-all"] }).plan.override,
    ).toBe("skip-all");
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

  test("a workflow runs when any of its real jobs run", () => {
    expect(build({}, ["src"]).plan.workflows.ci?.run).toBe(true);
    // plan and required still run, but neither is real work.
    expect(build().plan.workflows.ci?.run).toBe(false);
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
type WorkflowFile = { jobs: Record<string, { needs?: string | string[] }> };

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

  test("the gate job needs every job it has to verify", () => {
    const jobs = realConfig.workflows.ci ?? {};
    const gate = Object.keys(jobs).find((job) => jobs[job]?.gate);
    const needs = realWorkflows.ci?.jobs[gate ?? ""]?.needs ?? [];

    expect(gate).toBeDefined();
    expect([needs].flat().sort()).toEqual(
      Object.keys(jobs)
        .filter((job) => !jobs[job]?.gate)
        .sort(),
    );
  });
});
