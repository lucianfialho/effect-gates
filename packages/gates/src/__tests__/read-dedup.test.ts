import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { dedupLines, dedupSimilar } from "../read-dedup.js";

describe("dedupLines", () => {
  it("should remove exact duplicates", () => {
    const result = Effect.runSync(dedupLines(["a", "b", "a", "c", "b"]));
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("should preserve order of first occurrence", () => {
    const result = Effect.runSync(dedupLines(["x", "y", "z", "x", "y"]));
    expect(result).toEqual(["x", "y", "z"]);
  });

  it("should handle empty array", () => {
    const result = Effect.runSync(dedupLines([]));
    expect(result).toEqual([]);
  });

  it("should handle all unique lines", () => {
    const result = Effect.runSync(dedupLines(["a", "b", "c"]));
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("should handle all duplicate lines", () => {
    const result = Effect.runSync(dedupLines(["x", "x", "x", "x"]));
    expect(result).toEqual(["x"]);
  });
});

describe("dedupSimilar", () => {
  it("should remove similar lines above threshold", () => {
    const result = Effect.runSync(dedupSimilar(["hello", "hello world", "foo"], 0.6));
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("should keep dissimilar lines", () => {
    const result = Effect.runSync(dedupSimilar(["hello", "world", "foo", "bar"], 0.5));
    expect(result).toHaveLength(4);
  });

  it("should handle empty array", () => {
    const result = Effect.runSync(dedupSimilar([]));
    expect(result).toEqual([]);
  });
});