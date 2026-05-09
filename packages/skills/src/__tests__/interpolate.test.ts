import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  evaluateCondition,
  processConditionals,
  interpolateTemplate,
  resolveContextValue,
} from "../interpolate.js";
import type { SkillContext } from "../types.js";

const ctx = (overrides?: Partial<SkillContext>): SkillContext => ({
  skillName: "test",
  input: { target: "src/foo.ts", mode: "fast", count: 3, verbose: true },
  state: "analyze",
  lastOutput: { status: "ok", score: 42 },
  results: [{ state: "read", output: "code", timestamp: 0 }],
  errors: [],
  metadata: { methodology: { name: "SOLID" } },
  ...overrides,
});

// ── resolveContextValue ──────────────────────────────────────────────────────

describe("resolveContextValue", () => {
  it("resolves inputs.key", () => {
    expect(resolveContextValue("inputs.target", ctx())).toBe("src/foo.ts");
  });
  it("resolves lastOutput.field", () => {
    expect(resolveContextValue("lastOutput.status", ctx())).toBe("ok");
  });
  it("resolves context.state", () => {
    expect(resolveContextValue("context.state", ctx())).toBe("analyze");
  });
  it("resolves context.errors.length", () => {
    expect(resolveContextValue("context.errors.length", ctx())).toBe(0);
  });
  it("resolves context.results.length", () => {
    expect(resolveContextValue("context.results.length", ctx())).toBe(1);
  });
  it("resolves metadata.key", () => {
    expect(resolveContextValue("metadata.methodology", ctx())).toEqual({ name: "SOLID" });
  });
});

// ── evaluateCondition ────────────────────────────────────────────────────────

describe("evaluateCondition", () => {
  it("truthy check on present input", () => {
    expect(evaluateCondition("inputs.verbose", ctx())).toBe(true);
  });
  it("falsy check on absent input", () => {
    expect(evaluateCondition("inputs.missing", ctx())).toBe(false);
  });
  it("negation with !", () => {
    expect(evaluateCondition("!inputs.missing", ctx())).toBe(true);
    expect(evaluateCondition("!inputs.verbose", ctx())).toBe(false);
  });
  it("negation with not", () => {
    expect(evaluateCondition("not inputs.missing", ctx())).toBe(true);
  });
  it("string equality ==", () => {
    expect(evaluateCondition('inputs.mode == "fast"', ctx())).toBe(true);
    expect(evaluateCondition('inputs.mode == "slow"', ctx())).toBe(false);
  });
  it("string inequality !=", () => {
    expect(evaluateCondition('inputs.mode != "slow"', ctx())).toBe(true);
  });
  it("numeric comparison >", () => {
    expect(evaluateCondition("inputs.count > 2", ctx())).toBe(true);
    expect(evaluateCondition("inputs.count > 5", ctx())).toBe(false);
  });
  it("numeric comparison >=", () => {
    expect(evaluateCondition("inputs.count >= 3", ctx())).toBe(true);
  });
  it("lastOutput field comparison", () => {
    expect(evaluateCondition('lastOutput.status == "ok"', ctx())).toBe(true);
  });
  it("context.errors.length > 0", () => {
    expect(evaluateCondition("context.errors.length > 0", ctx())).toBe(false);
    expect(
      evaluateCondition("context.errors.length > 0",
        ctx({ errors: [{ state: "x", error: "e", timestamp: 0 }] })
      )
    ).toBe(true);
  });
});

// ── processConditionals ──────────────────────────────────────────────────────

describe("processConditionals", () => {
  it("renders if-body when condition is true", () => {
    expect(
      processConditionals("{% if inputs.verbose %}detailed{% endif %}", ctx())
    ).toBe("detailed");
  });

  it("renders else-body when condition is false", () => {
    expect(
      processConditionals("{% if inputs.missing %}yes{% else %}no{% endif %}", ctx())
    ).toBe("no");
  });

  it("nested conditionals resolved inside-out", () => {
    const tmpl = `{% if inputs.verbose %}outer {% if inputs.count > 2 %}inner{% endif %}{% endif %}`;
    expect(processConditionals(tmpl, ctx())).toBe("outer inner");
  });

  it("removes block when condition is false", () => {
    const result = processConditionals(
      "before{% if inputs.missing %} skipped{% endif %} after",
      ctx()
    );
    expect(result).toBe("before after");
  });

  it("works with string equality in condition", () => {
    const result = processConditionals(
      '{% if inputs.mode == "fast" %}fast mode{% else %}normal{% endif %}',
      ctx()
    );
    expect(result).toBe("fast mode");
  });
});

// ── interpolateTemplate ──────────────────────────────────────────────────────

describe("interpolateTemplate", () => {
  it("interpolates inputs", async () => {
    const result = await Effect.runPromise(
      interpolateTemplate("File: {{inputs.target}}", ctx())
    );
    expect(result).toBe("File: src/foo.ts");
  });

  it("interpolates lastOutput", async () => {
    const result = await Effect.runPromise(
      interpolateTemplate("Status: {{lastOutput.status}}", ctx())
    );
    expect(result).toBe("Status: ok");
  });

  it("interpolates methodology", async () => {
    const result = await Effect.runPromise(
      interpolateTemplate("Using {{methodology.name}}", ctx())
    );
    expect(result).toBe("Using SOLID");
  });

  it("applies conditionals then placeholders", async () => {
    const tmpl = "{% if inputs.verbose %}Detail: {{inputs.target}}{% else %}brief{% endif %}";
    const result = await Effect.runPromise(interpolateTemplate(tmpl, ctx()));
    expect(result).toBe("Detail: src/foo.ts");
  });

  it("handles missing file gracefully", async () => {
    const result = await Effect.runPromise(
      interpolateTemplate("{{file:nonexistent.md}}", ctx())
    );
    expect(result).toContain("[file not found: nonexistent.md]");
  });
});
