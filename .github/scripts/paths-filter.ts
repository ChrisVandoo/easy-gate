#!/usr/bin/env bun
/**
 * A tiny stand-in for dorny/paths-filter.
 *
 * Reads a YAML file of named groups, each a list of globs, works out which
 * files changed in a git range, and reports which groups those files touch.
 *
 * Usage:
 *   bun .github/scripts/paths-filter.ts [--config <path>] [--base <ref>] [--head <ref>]
 *
 * Defaults to the current commit (HEAD^...HEAD). When GITHUB_OUTPUT is set,
 * writes `<group>=true|false` for every group plus `changes=<json array>`.
 */

/** The empty tree, used as the base when HEAD has no parent. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type Filters = Record<string, string[]>;

export function parseFilters(source: string): Filters {
  const parsed = Bun.YAML.parse(source);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("filter config must be a mapping of group name to globs");
  }

  const filters: Filters = {};

  for (const [group, globs] of Object.entries(parsed)) {
    if (
      !Array.isArray(globs) ||
      globs.some((glob) => typeof glob !== "string")
    ) {
      throw new Error(`group "${group}" must be a list of glob strings`);
    }

    filters[group] = globs as string[];
  }

  return filters;
}

/** The groups whose globs match at least one of the changed files. */
export function matchGroups(filters: Filters, files: string[]): string[] {
  return Object.entries(filters)
    .filter(([, globs]) =>
      globs.some((pattern) => {
        const glob = new Bun.Glob(pattern);
        return files.some((file) => glob.match(file));
      }),
    )
    .map(([group]) => group);
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args]);

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  }

  return result.stdout.toString();
}

function revExists(ref: string): boolean {
  return (
    Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref]).exitCode ===
    0
  );
}

export function changedFiles(base: string, head: string): string[] {
  // Three dots diffs against the merge base, which is what we want both for a
  // single commit (HEAD^...HEAD) and for a pull request branch. The empty tree
  // is a tree rather than a commit, so it has no merge base and needs two dots.
  const range = base === EMPTY_TREE ? [base, head] : [`${base}...${head}`];

  return git(["diff", "--name-only", ...range])
    .split("\n")
    .filter((line) => line.length > 0);
}

function parseArgs(argv: string[]): Record<string, string> {
  const options: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      throw new Error(`expected --flag <value> pairs, got: ${argv.join(" ")}`);
    }

    options[flag.slice(2)] = value;
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const configPath = options.config ?? ".github/paths-filter.yaml";
  const head = options.head ?? "HEAD";
  // A root commit has no parent, so fall back to diffing against nothing.
  const base =
    options.base ?? (revExists(`${head}^`) ? `${head}^` : EMPTY_TREE);

  const filters = parseFilters(await Bun.file(configPath).text());
  const files = changedFiles(base, head);
  const matched = matchGroups(filters, files);

  console.log(`${files.length} file(s) changed in ${base}...${head}`);
  for (const file of files) {
    console.log(`  ${file}`);
  }

  for (const group of Object.keys(filters)) {
    console.log(`${group}: ${matched.includes(group)}`);
  }

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const lines = Object.keys(filters)
      .map((group) => `${group}=${matched.includes(group)}`)
      .concat(`changes=${JSON.stringify(matched)}`)
      .map((line) => `${line}\n`)
      .join("");

    await Bun.write(outputPath, (await Bun.file(outputPath).text()) + lines);
  }
}

if (import.meta.main) {
  await main();
}
