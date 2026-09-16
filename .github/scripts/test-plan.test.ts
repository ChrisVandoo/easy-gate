import { describe, expect, test } from "bun:test";
import { parseFilters } from "./paths-filter.ts";
import {
  COMMANDS,
  createPlan,
  DIFF_FAILED,
  type Facts,
  lookupJob,
  matchesCondition,
  type PlanContext,
  parseArgs,
  parseCondition,
  parseConfig,
  parsePlan,
  selectOverride,
  serializePlan,
  validateGroups,
  verifyPlan,
} from "./test-plan.ts";

const config = parseConfig(`
overrides:
  - id: skip-all
    skip:
      labels: [skip-all]
      event: [pull_request]
    reason: skip-all label is set
  - id: force-run
    run:
      labels: [force-run]
      event: [pull_request]
    reason: force-run label is set
  - id: protected-branch
    run:
      branch: [main, "release/**"]
    reason: pushes to a protected branch always run everything

workflows:
  ci:
    jobs:
      plan:
      lint:
        run:
          paths: [src, workflows]
      test:
        run:
          condition: any
          paths: [src]
          labels: [deep-test]
        skip:
          labels: [no-test]
          event: [pull_request]
        force-skip:
          labels: [no-tests]
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

function facts(
  overrides: Partial<PlanContext> = {},
  changedGroups: string[] = [],
): Facts {
  return { ...context(overrides), changedGroups };
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

/** A `run:` or `skip:` block on its own, for testing conditions directly. */
function condition(yaml: string, allowDiff = true) {
  return parseCondition(Bun.YAML.parse(yaml), "test", allowDiff);
}

describe("parseConfig", () => {
  test("reads overrides in order", () => {
    expect(config.overrides.map((override) => override.id)).toEqual([
      "skip-all",
      "force-run",
      "protected-branch",
    ]);
  });

  test("reads an override's blocks, and only the ones it has", () => {
    expect(config.overrides[0]).toEqual({
      id: "skip-all",
      skip: {
        mode: "all",
        predicates: { labels: ["skip-all"], event: ["pull_request"] },
      },
      reason: "skip-all label is set",
    });
  });

  test("reads a job's conditions", () => {
    expect(config.workflows.ci?.test).toEqual({
      calls: undefined,
      run: {
        mode: "any",
        predicates: { paths: ["src"], labels: ["deep-test"] },
      },
      skip: {
        mode: "all",
        predicates: { labels: ["no-test"], event: ["pull_request"] },
      },
      "force-skip": { mode: "all", predicates: { labels: ["no-tests"] } },
    });
  });

  test("defaults a block to `condition: all`", () => {
    expect(condition("labels: [a]").mode).toBe("all");
  });

  test("rejects a condition that is neither all nor any", () => {
    expect(() => condition("condition: some\nlabels: [a]")).toThrow(
      /condition must be all \| any/,
    );
  });

  test("rejects an unknown condition", () => {
    expect(() => condition("phase: [moon]")).toThrow(
      /unknown condition "phase"/,
    );
  });

  test("rejects an empty block, which would be a typo rather than a rule", () => {
    expect(() => condition("{}")).toThrow(/needs at least one condition/);
  });

  test("rejects a condition whose value is the wrong shape", () => {
    expect(() => condition("labels: yes")).toThrow(/must be a list of strings/);
    expect(() => condition("draft: [true]")).toThrow(/must be true or false/);
    expect(() => condition("event: 3")).toThrow(/must be a list of strings/);
  });

  test("rejects `paths` in an override, which is decided before the diff", () => {
    expect(() => condition("paths: [src]", false)).toThrow(
      /cannot use "paths" — an override is decided before the diff/,
    );
    // Including in a `skip` block, which is read the same way as a `run` one.
    expect(() =>
      parseConfig(
        "overrides:\n  - id: x\n    skip:\n      paths: [src]\nworkflows: {}",
      ),
    ).toThrow(/cannot use "paths"/);
  });

  test("rejects an override with no block at all", () => {
    expect(() =>
      parseConfig("overrides:\n  - id: x\n    reason: y\nworkflows: {}"),
    ).toThrow(/needs a `run` or `skip` block/);
  });

  test("rejects `force-skip` in an override, which is workflow level", () => {
    expect(() =>
      parseConfig(
        "overrides:\n  - id: x\n    force-skip:\n      labels: [halt]\nworkflows: {}",
      ),
    ).toThrow(
      /cannot use `force-skip` — that is a workflow level setting, and an override already outranks/,
    );
  });

  test("rejects a workflow without jobs", () => {
    expect(() => parseConfig("workflows:\n  ci: {}")).toThrow(/`jobs` mapping/);
  });
});

describe("matchesCondition", () => {
  test("matches any of the listed labels", () => {
    expect(
      matchesCondition(condition("labels: [a, b]"), facts({ labels: ["b"] })),
    ).toBe(true);
  });

  test("matches a branch by name", () => {
    const branch = condition("branch: [main]");

    expect(matchesCondition(branch, facts({ ref: "main" }))).toBe(true);
    expect(matchesCondition(branch, facts({ ref: "mainly" }))).toBe(false);
  });

  test("matches a branch by glob", () => {
    const branch = condition(`branch: ["release/*", "renovate/**"]`);

    expect(matchesCondition(branch, facts({ ref: "release/1.2" }))).toBe(true);
    // `*` stops at a slash, `**` does not.
    expect(matchesCondition(branch, facts({ ref: "release/1.2/fix" }))).toBe(
      false,
    );
    expect(matchesCondition(branch, facts({ ref: "renovate/a/b" }))).toBe(true);
    expect(matchesCondition(branch, facts({ ref: "feature" }))).toBe(false);
  });

  test("matches a label by glob", () => {
    expect(
      matchesCondition(
        condition(`labels: ["ci/*"]`),
        facts({ labels: ["ci/skip"] }),
      ),
    ).toBe(true);
  });

  test("matches a pull request on its head branch, not its base", () => {
    // A pull request into main is still a pull request, so the branch
    // override must not fire on it.
    expect(
      matchesCondition(condition("branch: [main]"), facts({ baseRef: "main" })),
    ).toBe(false);
  });

  test("matches a path group the diff touched", () => {
    const paths = condition("paths: [src]");

    expect(matchesCondition(paths, facts({}, ["src", "workflows"]))).toBe(true);
    expect(matchesCondition(paths, facts({}, ["workflows"]))).toBe(false);
  });

  test("`all` is the default, so every condition has to hold", () => {
    const both = condition("labels: [a]\nevent: [push]");

    expect(
      matchesCondition(both, facts({ labels: ["a"], event: "push" })),
    ).toBe(true);
    expect(matchesCondition(both, facts({ labels: ["a"] }))).toBe(false);
  });

  test("`any` needs only one of them", () => {
    const either = condition("condition: any\nlabels: [a]\nevent: [push]");

    expect(matchesCondition(either, facts({ labels: ["a"] }))).toBe(true);
    expect(matchesCondition(either, facts({ event: "push" }))).toBe(true);
    expect(matchesCondition(either, facts({ labels: ["b"] }))).toBe(false);
  });
});

describe("the event condition", () => {
  test("matches the triggering event by name", () => {
    const pr = condition("event: [pull_request, push]");

    expect(matchesCondition(pr, facts({ event: "pull_request" }))).toBe(true);
    expect(matchesCondition(pr, facts({ event: "push" }))).toBe(true);
    expect(matchesCondition(pr, facts({ event: "schedule" }))).toBe(false);
  });

  test("matches exactly, since an event name is not a glob", () => {
    expect(
      matchesCondition(
        condition("event: [pull]"),
        facts({ event: "pull_request" }),
      ),
    ).toBe(false);
  });
});

describe("selectOverride", () => {
  test("takes the first override that matches", () => {
    expect(
      selectOverride(config, context({ labels: ["force-run", "skip-all"] }))
        ?.id,
    ).toBe("skip-all");
  });

  test("ands an override's conditions together", () => {
    // skip-all is `labels AND event: pull_request`, so the label alone does
    // nothing on a push.
    expect(
      selectOverride(config, context({ labels: ["skip-all"], event: "push" })),
    ).toBeNull();
  });

  test("carries the decision and the reason the config gave", () => {
    expect(selectOverride(config, context({ labels: ["force-run"] }))).toEqual({
      id: "force-run",
      run: true,
      reason: "force-run label is set",
    });
  });

  test("prefers a run block to a skip block in the same override", () => {
    const both = parseConfig(`
overrides:
  - id: mixed
    run:
      labels: [ship-it]
    skip:
      labels: [ship-it]
    reason: run beats skip
workflows: {}
`);

    expect(selectOverride(both, context({ labels: ["ship-it"] }))?.run).toBe(
      true,
    );
  });

  test("matches nothing when no override applies", () => {
    expect(selectOverride(config, context())).toBeNull();
  });
});

describe("createPlan", () => {
  test("filters on changed paths", () => {
    const { plan } = build({}, ["workflows"]);

    expect(jobs(plan)).toEqual({ plan: true, lint: true, test: false });
    expect(plan.workflows.ci?.jobs.lint?.reason).toBe(
      "run condition met: paths: workflows",
    );
    expect(plan.workflows.ci?.jobs.test?.reason).toBe(
      "no run condition met: paths: src or labels: deep-test",
    );
  });

  test("runs a job with no conditions at all", () => {
    expect(jobs(build().plan).plan).toBe(true);
    expect(build().plan.workflows.ci?.jobs.plan?.reason).toBe(
      "no conditions, always runs",
    );
  });

  test("runs nothing conditional when no group is touched", () => {
    expect(jobs(build().plan)).toEqual({
      plan: true,
      lint: false,
      test: false,
    });
  });

  test("runs everything on a protected branch", () => {
    const { plan, askedForDiff } = build({ event: "push", ref: "main" });

    expect(plan.override).toBe("protected-branch");
    // The override settles every job, so there is nothing for a diff to tell
    // us — and on the default branch that diff is the most expensive one.
    expect(askedForDiff).toBe(false);
    expect(plan.inputs.changedGroups).toBeNull();
    expect(jobs(plan)).toEqual({ plan: true, lint: true, test: true });
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
    expect(jobs(plan)).toEqual({ plan: true, lint: true, test: true });
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
    expect(jobs(build({ labels: ["force-run"] }).plan).test).toBe(true);
  });

  test("skip-all beats a diff that would otherwise run jobs", () => {
    const { plan } = build({ labels: ["skip-all"] }, ["src", "workflows"]);

    expect(jobs(plan)).toEqual({ plan: false, lint: false, test: false });
  });

  test("an override outranks everything a job says about itself", () => {
    // The old syntax let a job's own `when` outrank a blanket skip. It does
    // not any more: overrides always take precedence.
    const { plan } = build({ labels: ["skip-all", "deep-test"] });

    expect(plan.override).toBe("skip-all");
    expect(jobs(plan).test).toBe(false);
    expect(lookupJob(plan, "ci", "test").reason).toBe("skip-all label is set");
  });

  test("a job's `condition: any` runs it on either a path or a label", () => {
    const { plan: byLabel } = build({ labels: ["deep-test"] });
    const { plan: byPath } = build({}, ["src"]);

    expect(jobs(byLabel).test).toBe(true);
    expect(lookupJob(byLabel, "ci", "test").reason).toBe(
      "run condition met: labels: deep-test",
    );
    expect(jobs(byPath).test).toBe(true);
    expect(lookupJob(byPath, "ci", "test").reason).toBe(
      "run condition met: paths: src",
    );
    // Only the job that asked for it — this is not another blanket override.
    expect(jobs(byLabel).lint).toBe(false);
  });

  test("a label that matches nothing leaves the path filter to decide", () => {
    expect(jobs(build({ labels: ["unrelated"] }, ["src"]).plan).test).toBe(
      true,
    );
    expect(
      jobs(build({ labels: ["unrelated"] }, ["workflows"]).plan).test,
    ).toBe(false);
  });

  test("a job with only a skip block runs until that skip matches", () => {
    const docs = parseConfig(`
workflows:
  ci:
    jobs:
      docs:
        skip:
          labels: [no-docs]
`);
    const built = (labels: string[]) =>
      createPlan(docs, context({ labels }), () => ({
        changedFiles: [],
        changedGroups: [],
      }));

    expect(lookupJob(built([]), "ci", "docs").run).toBe(true);
    expect(lookupJob(built(["no-docs"]), "ci", "docs")).toEqual({
      run: false,
      reason: "skip condition met: labels: no-docs",
    });
  });

  test("a skip block ands its conditions together by default", () => {
    // `test`'s skip is `no-test` AND a pull request, so on a push the label
    // alone does not fire it, and the run block is left to decide.
    expect(
      lookupJob(build({ labels: ["no-test"] }).plan, "ci", "test"),
    ).toEqual({
      run: false,
      reason: "skip condition met: labels: no-test and event: pull_request",
    });
    expect(
      lookupJob(
        build({ labels: ["no-test"], event: "push" }).plan,
        "ci",
        "test",
      ).reason,
    ).toMatch(/no run condition met/);
  });

  test("force-skip holds a job back even when its run condition matched", () => {
    const { plan } = build({ labels: ["no-tests", "deep-test"] }, ["src"]);

    expect(jobs(plan).test).toBe(false);
    expect(lookupJob(plan, "ci", "test").reason).toBe(
      "force-skip condition met: labels: no-tests (which beats the matching run condition)",
    );
  });

  test("force-skip says nothing when its own conditions do not hold", () => {
    // It is a veto, not a default: without the label the run block decides.
    expect(jobs(build({}, ["src"]).plan).test).toBe(true);
  });

  test("force-skip does not bother naming a skip it also outranks", () => {
    // Both would have skipped the job, so there is nothing surprising to say.
    const { plan } = build({ labels: ["no-tests", "no-test"] });

    expect(lookupJob(plan, "ci", "test").reason).toBe(
      "force-skip condition met: labels: no-tests",
    );
  });

  test("an override outranks a job's force-skip", () => {
    // `force-skip` tops the ladder among a workflow's own settings, and that
    // is all it tops: an override is decided first and beats every one of
    // them, so the two `ALWAYS` rules never actually collide.
    const { plan } = build({ labels: ["no-tests", "force-run"] });

    expect(plan.override).toBe("force-run");
    expect(jobs(plan).test).toBe(true);
    expect(lookupJob(plan, "ci", "test").reason).toBe("force-run label is set");
  });

  test("a matching run condition beats a matching skip condition", () => {
    // Which is the documented rule, and it cuts both ways: `no-test` cannot
    // hold back a job whose `run` block matched on the diff.
    const { plan } = build({ labels: ["no-test", "deep-test"] }, ["src"]);

    expect(jobs(plan).test).toBe(true);
    expect(lookupJob(plan, "ci", "test").reason).toBe(
      "run condition met: paths: src and labels: deep-test (which beats the matching skip condition)",
    );
  });

  test("a job's conditions still do not make the diff worth working out", () => {
    // The diff decides the other jobs, so it is still asked for — the point is
    // that a label does not stand in for it.
    expect(build({ labels: ["deep-test"] }).askedForDiff).toBe(true);
  });

  test("a workflow runs when any of its jobs run", () => {
    expect(build({}, ["src"]).plan.workflows.ci?.run).toBe(true);
    // `plan` has no conditions, so it runs, and so does the workflow.
    expect(build().plan.workflows.ci?.run).toBe(true);
    expect(build({ labels: ["skip-all"] }).plan.workflows.ci?.run).toBe(false);
  });
});

describe("createPlan with a called workflow", () => {
  const nested = parseConfig(`
overrides:
  - id: skip-all
    skip:
      labels: [skip-all]
    reason: skip-all label is set

workflows:
  ci:
    jobs:
      test:
        calls: test
  test:
    jobs:
      unit:
        run:
          paths: [src]
      docs:
        run:
          paths: [workflows]
`);

  function planNested(changed: string[], labels: string[] = []) {
    return createPlan(nested, context({ labels }), () => ({
      changedFiles: changed.map((group) => `${group}/file.ts`),
      changedGroups: changed,
    }));
  }

  test("filters the called workflow's jobs in their own right", () => {
    const built = planNested(["src"]);

    expect(lookupJob(built, "test", "unit").run).toBe(true);
    expect(lookupJob(built, "test", "docs").run).toBe(false);
  });

  test("the calling job runs when the called workflow has work in it", () => {
    expect(lookupJob(planNested(["workflows"]), "ci", "test")).toEqual({
      run: true,
      reason: "the test workflow has jobs to run",
    });
  });

  test("the calling job is skipped when every nested job is", () => {
    const built = planNested([]);

    expect(lookupJob(built, "ci", "test")).toEqual({
      run: false,
      reason: "nothing to run in the test workflow",
    });
    // ...which is the whole point: the nested filter reaches the caller, so no
    // runner is spent starting a workflow with nothing to do.
    expect(built.workflows.ci?.run).toBe(false);
  });

  test("an override reaches the nested jobs, and so the caller", () => {
    const built = planNested(["src"], ["skip-all"]);

    expect(lookupJob(built, "test", "unit").run).toBe(false);
    expect(lookupJob(built, "ci", "test").run).toBe(false);
  });

  test("force-skipping every nested job stops the caller too", () => {
    const halted = parseConfig(`
workflows:
  ci:
    jobs:
      test:
        calls: test
  test:
    jobs:
      unit:
        run:
          paths: [src]
        force-skip:
          labels: [no-tests]
`);
    const built = createPlan(halted, context({ labels: ["no-tests"] }), () => ({
      changedFiles: ["src/index.ts"],
      changedGroups: ["src"],
    }));

    expect(lookupJob(built, "test", "unit").run).toBe(false);
    expect(lookupJob(built, "ci", "test").run).toBe(false);
    expect(built.workflows.ci?.run).toBe(false);
  });

  test("rejects a call to a workflow that is not described", () => {
    expect(() =>
      parseConfig(
        "workflows:\n  ci:\n    jobs:\n      test:\n        calls: nope",
      ),
    ).toThrow(/not described here/);
  });

  test("rejects conditions sitting beside a call", () => {
    expect(() =>
      parseConfig(
        "workflows:\n  ci:\n    jobs:\n      test:\n        calls: test\n        run:\n          paths: [src]",
      ),
    ).toThrow(/cannot combine `calls` with run/);
    expect(() =>
      parseConfig(
        "workflows:\n  ci:\n    jobs:\n      test:\n        calls: test\n        force-skip:\n          labels: [x]",
      ),
    ).toThrow(/cannot combine `calls` with force-skip/);
  });

  test("rejects a workflow that ends up calling itself", () => {
    const cyclic = {
      overrides: [],
      workflows: {
        a: { call: { calls: "b" } },
        b: { call: { calls: "a" } },
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
    const built = planOf(20);

    expect(parsePlan(serializePlan(built))).toEqual(built);
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
    const built = planOf(10);
    const bytes = new TextEncoder().encode(serializePlan(built)).length;

    expect(() => serializePlan(built, bytes)).not.toThrow();
    expect(() => serializePlan(built, bytes - 1)).toThrow();
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
  const { plan: built } = build({}, ["src"]);

  test("finds a job", () => {
    expect(lookupJob(built, "ci", "test").run).toBe(true);
  });

  test("names the jobs it does know about", () => {
    expect(() => lookupJob(built, "ci", "nope")).toThrow(/only plan, lint/);
  });

  test("rejects an unknown workflow", () => {
    expect(() => lookupJob(built, "nope", "test")).toThrow(
      /no workflow "nope"/,
    );
  });
});

describe("verifyPlan", () => {
  const { plan: built } = build({}, ["workflows"]);

  const check = (results: Record<string, { result?: string }>) =>
    Object.fromEntries(
      verifyPlan(built, "ci", results).map((result) => [result.job, result.ok]),
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
    const [result] = verifyPlan(built, "ci", {
      plan: { result: "success" },
      test: { result: "skipped" },
    }).filter((entry) => entry.job === "lint");

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

  test("never expects a job the plan does not govern", () => {
    // The job doing the verifying is not in its own `needs`, so it never shows
    // up in the results — and it is not in the config either.
    expect(
      verifyPlan(built, "ci", { plan: { result: "success" } }).map(
        (entry) => entry.job,
      ),
    ).not.toContain("verify");
  });

  test("passes a skip-all run, so the required check stays green", () => {
    const { plan: skipped } = build({ labels: ["skip-all"] });

    expect(
      verifyPlan(skipped, "ci", {
        plan: { result: "skipped" },
        lint: { result: "skipped" },
        test: { result: "skipped" },
      }).every((entry) => entry.ok),
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

  // The other way round is allowed: a workflow may carry jobs the plan does
  // not govern, such as the one that builds the plan and the one that checks
  // it afterwards.
  test.each(Object.keys(realConfig.workflows))(
    "every job %s names really exists in the workflow",
    (name) => {
      const declared = Object.keys(realWorkflows[name]?.jobs ?? {});

      for (const job of Object.keys(realConfig.workflows[name] ?? {})) {
        expect(declared).toContain(job);
      }
    },
  );

  // A `calls` that names the wrong workflow would plan one workflow and run
  // another, and both would look fine on their own.
  test("every `calls` job really is a call, to the workflow it names", () => {
    for (const [name, workflowJobs] of Object.entries(realConfig.workflows)) {
      for (const [job, options] of Object.entries(workflowJobs)) {
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

  test("a change under src reaches the nested jobs, and so their callers", () => {
    const built = createPlan(realConfig, context(), () => ({
      changedFiles: ["src/index.ts"],
      changedGroups: ["src"],
    }));

    expect(lookupJob(built, "test", "test").run).toBe(true);
    expect(lookupJob(built, "ci", "test").run).toBe(true);
    expect(lookupJob(built, "lint", "lint").run).toBe(true);
  });

  test("a change only under workflows leaves the tests alone", () => {
    const built = createPlan(realConfig, context(), () => ({
      changedFiles: [".github/workflows/ci.yml"],
      changedGroups: ["workflows"],
    }));

    expect(lookupJob(built, "lint", "lint").run).toBe(true);
    expect(lookupJob(built, "ci", "test").run).toBe(false);
  });

  test("its `deep-test` label asks for the tests on its own", () => {
    // `condition: any`, so the label stands in for a diff that touched src.
    const built = createPlan(
      realConfig,
      context({ labels: ["deep-test"] }),
      () => ({ changedFiles: [], changedGroups: [] }),
    );

    expect(lookupJob(built, "test", "test").reason).toBe(
      "run condition met: labels: deep-test",
    );
    expect(lookupJob(built, "ci", "test").run).toBe(true);
    // Only the job that asked for it; lint is left to the diff.
    expect(lookupJob(built, "lint", "lint").run).toBe(false);
  });

  test("its `no-tests` label holds the tests back whatever the diff says", () => {
    const built = createPlan(
      realConfig,
      context({ labels: ["no-tests", "deep-test"] }),
      () => ({ changedFiles: ["src/index.ts"], changedGroups: ["src"] }),
    );

    expect(lookupJob(built, "test", "test").run).toBe(false);
    expect(lookupJob(built, "ci", "test").run).toBe(false);
    // Only the tests: lint still follows the diff.
    expect(lookupJob(built, "lint", "lint").run).toBe(true);
  });

  test("skip-all only applies to a pull request, as its conditions say", () => {
    const labelled = { labels: ["skip-all"] };
    const diff = () => ({ changedFiles: [], changedGroups: ["src"] });

    expect(createPlan(realConfig, context(labelled), diff).override).toBe(
      "skip-all",
    );
    // The same label on a push to a feature branch decides nothing.
    expect(
      createPlan(
        realConfig,
        context({ ...labelled, event: "push", ref: "feature" }),
        diff,
      ).override,
    ).toBeNull();
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
