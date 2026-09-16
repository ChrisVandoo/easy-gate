import { describe, expect, test } from "bun:test";

import { greet } from "./greet.ts";

describe("greet", () => {
  test("defaults to World", () => {
    expect(greet()).toBe("Hello, World!");
  });

  test("uses the given name", () => {
    expect(greet("Chris")).toBe("Hello, Chris!");
  });
});
