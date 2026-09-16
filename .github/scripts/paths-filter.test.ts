import { describe, expect, test } from "bun:test";

import { matchGroups, parseFilters } from "./paths-filter.ts";

const filters = parseFilters(`
src:
  - src/**
  - package.json
workflows:
  - .github/workflows/**
`);

describe("parseFilters", () => {
  test("reads groups and their globs", () => {
    expect(filters).toEqual({
      src: ["src/**", "package.json"],
      workflows: [".github/workflows/**"],
    });
  });

  test("rejects a group that is not a list of globs", () => {
    expect(() => parseFilters("src: true")).toThrow(/list of glob strings/);
  });
});

describe("matchGroups", () => {
  test("matches a nested path", () => {
    expect(matchGroups(filters, ["src/greet.ts"])).toEqual(["src"]);
  });

  test("matches an exact path", () => {
    expect(matchGroups(filters, ["package.json"])).toEqual(["src"]);
  });

  test("returns every group the files touch", () => {
    expect(
      matchGroups(filters, ["src/greet.ts", ".github/workflows/ci.yml"]),
    ).toEqual(["src", "workflows"]);
  });

  test("returns nothing when no file matches", () => {
    expect(matchGroups(filters, ["README.md"])).toEqual([]);
  });

  test("returns nothing for an empty diff", () => {
    expect(matchGroups(filters, [])).toEqual([]);
  });
});
