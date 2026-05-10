import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import type { SkillContext } from "./types.js";

// ── Context value resolver ───────────────────────────────────────────────────

/**
 * Resolves a dot-path expression against SkillContext.
 *
 * Supported paths:
 *   inputs.key           → context.input["key"]
 *   lastOutput           → context.lastOutput
 *   lastOutput.field     → context.lastOutput["field"] (when object)
 *   outputs.field        → alias for lastOutput.field
 *   context.state        → context.state
 *   context.errors.length
 *   context.results.length
 *   metadata.key         → context.metadata["key"]
 */
export const resolveContextValue = (expr: string, context: SkillContext): unknown => {
  const parts = expr.trim().split(".");

  switch (parts[0]) {
    case "inputs":
      return parts.length === 1 ? context.input : context.input[parts[1] ?? ""];

    case "lastOutput":
    case "outputs": {
      if (parts.length === 1) return context.lastOutput;
      const obj =
        context.lastOutput !== null &&
        context.lastOutput !== undefined &&
        typeof context.lastOutput === "object"
          ? (context.lastOutput as Record<string, unknown>)
          : {};
      return obj[parts[1] ?? ""];
    }

    case "context":
      if (parts[1] === "state") return context.state;
      if (parts[1] === "errors") {
        return parts[2] === "length" ? context.errors.length : context.errors;
      }
      if (parts[1] === "results") {
        return parts[2] === "length" ? context.results.length : context.results;
      }
      return undefined;

    case "metadata":
      return parts.length === 1 ? context.metadata : context.metadata[parts[1] ?? ""];

    default:
      // Bare key — try inputs first, then metadata
      return context.input[parts[0]] ?? context.metadata[parts[0]];
  }
};

// ── Condition evaluator ──────────────────────────────────────────────────────

/**
 * Evaluates a condition expression without `new Function`.
 *
 * Supported forms:
 *   inputs.key                    → truthy check
 *   !inputs.key                   → falsy check
 *   inputs.key == "value"         → string equality
 *   inputs.key != "value"         → string inequality
 *   context.errors.length > 0     → numeric comparison (>, <, >=, <=)
 *   lastOutput.status == "ok"     → field equality
 */
export const evaluateCondition = (expr: string, context: SkillContext): boolean => {
  const trimmed = expr.trim();

  // Negation: !expr or "not expr"
  if (trimmed.startsWith("!")) {
    return !evaluateCondition(trimmed.slice(1), context);
  }
  if (trimmed.startsWith("not ")) {
    return !evaluateCondition(trimmed.slice(4), context);
  }

  // String comparison: path == "value" or path != "value"
  const strMatch = trimmed.match(/^(.+?)\s*(==|!=)\s*["']([^"']*)["']$/);
  if (strMatch) {
    const [, left, op, right] = strMatch;
    const leftVal = String(resolveContextValue(left.trim(), context) ?? "");
    return op === "==" ? leftVal === right : leftVal !== right;
  }

  // Numeric comparison: path > N, path < N, path >= N, path <= N
  const numMatch = trimmed.match(/^(.+?)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (numMatch) {
    const [, left, op, right] = numMatch;
    const leftVal = Number(resolveContextValue(left.trim(), context) ?? 0);
    const rightVal = Number(right);
    if (isNaN(leftVal)) return false;
    switch (op) {
      case ">":  return leftVal > rightVal;
      case "<":  return leftVal < rightVal;
      case ">=": return leftVal >= rightVal;
      case "<=": return leftVal <= rightVal;
    }
  }

  // Truthy check: bare path
  const val = resolveContextValue(trimmed, context);
  if (val === undefined || val === null || val === "" || val === 0 || val === false) {
    return false;
  }
  return true;
};

// ── Conditional blocks ────────────────────────────────────────────────────────

/**
 * Processes {% if cond %}...{% else %}...{% endif %} blocks using a stack parser.
 * Correctly handles arbitrary nesting depth.
 *
 * @example
 * `{% if inputs.verbose %}detailed{% else %}brief{% endif %}`
 * `{% if inputs.mode == "fast" %}fast{% if inputs.verbose %} (+verbose){% endif %}{% endif %}`
 */
export const processConditionals = (template: string, context: SkillContext): string => {
  // Split on any {% ... %} tag, capturing the tags as tokens
  const tokens = template.split(/(\{%[\s\S]*?%\})/);

  const stack: Array<{ condition: boolean; inElse: boolean }> = [];
  const output: string[] = [];

  for (const token of tokens) {
    if (!token.startsWith("{%")) {
      // Text token — output only when all conditions in the stack are satisfied
      const active = stack.every((s) => (s.inElse ? !s.condition : s.condition));
      if (active) output.push(token);
      continue;
    }

    const ifMatch = token.match(/\{%\s*if\s+([\s\S]+?)\s*%\}/);
    const isElse = /\{%\s*else\s*%\}/.test(token);
    const isEndif = /\{%\s*endif\s*%\}/.test(token);

    if (ifMatch) {
      stack.push({ condition: evaluateCondition(ifMatch[1], context), inElse: false });
    } else if (isElse) {
      if (stack.length > 0) stack[stack.length - 1]!.inElse = true;
    } else if (isEndif) {
      stack.pop();
    } else {
      // Unknown tag — pass through if active
      const active = stack.every((s) => (s.inElse ? !s.condition : s.condition));
      if (active) output.push(token);
    }
  }

  return output.join("");
};

// ── File injection ────────────────────────────────────────────────────────────

/**
 * Resolves all {{file:path/to/file}} placeholders by reading file contents.
 * Path is relative to basePath (defaults to process.cwd()).
 * Missing files produce a visible `[file not found: ...]` marker.
 */
export const injectFiles = (
  template: string,
  basePath?: string
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const FILE_PATTERN = /\{\{file:([^}]+)\}\}/g;
    const matches = [...template.matchAll(FILE_PATTERN)];

    if (matches.length === 0) return template;

    let result = template;
    const base = path.resolve(basePath ?? process.cwd());

    for (const match of matches) {
      const filePath = match[1].trim();
      const fullPath = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(base, filePath);

      // Path traversal guard: resolved path must stay within basePath
      if (!fullPath.startsWith(base + path.sep) && fullPath !== base) {
        result = result.replace(match[0], `[file access denied: ${filePath}]`);
        continue;
      }

      const loaded = yield* Effect.result(
        Effect.tryPromise({
          try: () => fs.promises.readFile(fullPath, "utf-8"),
          catch: (e) => new Error(String(e)),
        })
      );

      const replacement =
        loaded._tag === "Success"
          ? loaded.success.trim()
          : `[file not found: ${filePath}]`;

      result = result.replace(match[0], replacement);
    }

    return result;
  });

// ── Standard placeholder interpolation ───────────────────────────────────────

const interpolatePlaceholders = (template: string, context: SkillContext): string => {
  let result = template;

  // {{inputs.key}}
  result = result.replace(/\{\{inputs\.(\w+)\}\}/g, (_, key) => {
    const val = context.input[key];
    return val !== undefined ? String(val) : `{{inputs.${key}}}`;
  });

  // {{lastOutput}} and {{lastOutput.field}} and {{outputs.field}}
  if (context.lastOutput !== undefined) {
    const lastStr =
      typeof context.lastOutput === "object"
        ? JSON.stringify(context.lastOutput)
        : String(context.lastOutput);

    result = result.replace(/\{\{lastOutput\}\}/g, lastStr);

    if (typeof context.lastOutput === "object" && context.lastOutput !== null) {
      const obj = context.lastOutput as Record<string, unknown>;
      result = result.replace(/\{\{(?:lastOutput|outputs)\.(\w+)\}\}/g, (_, field) =>
        obj[field] !== undefined ? String(obj[field]) : `{{${field}}}`
      );
    }
  }

  // {{methodology.key}}
  if (context.metadata.methodology && typeof context.metadata.methodology === "object") {
    const methodology = context.metadata.methodology as Record<string, unknown>;
    result = result.replace(/\{\{methodology\.(\w+)\}\}/g, (_, key) =>
      methodology[key] !== undefined ? String(methodology[key]) : `{{methodology.${key}}}`
    );
  }

  // {{metadata.key}}
  result = result.replace(/\{\{metadata\.(\w+)\}\}/g, (_, key) => {
    const val = context.metadata[key];
    return val !== undefined ? String(val) : `{{metadata.${key}}}`;
  });

  return result;
};

// ── Main entry point ──────────────────────────────────────────────────────────

export interface InterpolateOptions {
  /** Base path for resolving {{file:...}} (default: process.cwd()) */
  readonly basePath?: string;
}

/**
 * Full template interpolation pipeline:
 *   1. Conditionals:  {% if cond %}...{% endif %}
 *   2. File injection: {{file:path/to/file.md}}
 *   3. Placeholders:  {{inputs.key}}, {{lastOutput}}, {{methodology.x}}, etc.
 */
export const interpolateTemplate = (
  template: string,
  context: SkillContext,
  options?: InterpolateOptions
): Effect.Effect<string> =>
  Effect.gen(function* () {
    // 1. Resolve conditionals (sync)
    const afterConditionals = processConditionals(template, context);

    // 2. Inject file contents (async)
    const afterFiles = yield* injectFiles(afterConditionals, options?.basePath);

    // 3. Standard placeholder substitution (sync)
    return interpolatePlaceholders(afterFiles, context);
  });
