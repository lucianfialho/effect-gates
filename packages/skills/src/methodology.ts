import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import yaml from "js-yaml";
import type { MethodologyRule, MethodologyGuardrail, MethodologyEvaluation } from "./types.js";

export interface LoadedMethodology {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly rules: MethodologyRule[];
  readonly patterns: Record<string, unknown>;
  readonly guardrails: MethodologyGuardrail[];
  readonly evaluation?: MethodologyEvaluation;
  readonly rawContent: string;
}

export const loadMethodology = (
  methodologyName: string,
  basePath?: string
): Effect.Effect<LoadedMethodology, Error> =>
  Effect.gen(function* () {
    const base = basePath ?? process.cwd();
    const methodologyPath = path.join(base, ".gates", "methodologies", `${methodologyName}.yaml`);

    const exists = yield* Effect.tryPromise(() =>
      fs.promises.access(methodologyPath).then(() => true).catch(() => false)
    );

    if (!exists) {
      return yield* Effect.fail(new Error(`Methodology not found: ${methodologyName} at ${methodologyPath}`));
    }

    const content = yield* Effect.tryPromise(() => fs.promises.readFile(methodologyPath, "utf-8"));

    const methodology = parseMethodologyYaml(content);

    return methodology;
  });

interface RawMethodologyYaml {
  name?: string;
  description?: string;
  version?: string;
  rules?: Array<Record<string, unknown>>;
  guardrails?: Array<Record<string, unknown>>;
  patterns?: Record<string, unknown>;
  evaluation?: { heuristics?: Array<{ rule: string; check: string }> };
}

const parseMethodologyYaml = (content: string): LoadedMethodology => {
  const raw = yaml.load(content) as RawMethodologyYaml;

  const rules: MethodologyRule[] = (raw.rules ?? []).map((r) => ({
    id: String(r["id"] ?? ""),
    name: String(r["name"] ?? ""),
    description: String(r["description"] ?? ""),
    examples: (r["examples"] as Array<{ before: string; after: string }> | undefined) ?? [],
    patterns: (r["patterns"] as string[] | undefined) ?? [],
    anti_patterns: (r["anti_patterns"] as string[] | undefined) ?? [],
  }));

  const guardrails: MethodologyGuardrail[] = (raw.guardrails ?? []).map((g) => ({
    id: String(g["id"] ?? ""),
    description: String(g["description"] ?? ""),
  }));

  return {
    name: raw.name ?? "Unknown",
    description: raw.description ?? "",
    version: raw.version ?? "1.0",
    rules,
    patterns: raw.patterns ?? {},
    guardrails,
    evaluation: raw.evaluation,
    rawContent: content,
  };
};

export const formatMethodologyForPrompt = (methodology: LoadedMethodology): string => {
  let result = `# ${methodology.name}\n${methodology.description}\n\n`;

  result += "## Rules\n";
  for (const rule of methodology.rules) {
    result += `### ${rule.id}: ${rule.name}\n${rule.description}\n`;
    const examples = rule.examples ?? [];
    if (examples.length > 0) {
      result += "Examples:\n";
      for (const example of examples) {
        if (example.before) result += `Before:\n\`\`\`\n${example.before}\n\`\`\`\n`;
        if (example.after) result += `After:\n\`\`\`\n${example.after}\n\`\`\`\n`;
      }
    }
    const patterns = rule.patterns ?? [];
    if (patterns.length > 0) {
      result += `Patterns: ${patterns.join(", ")}\n`;
    }
    const antiPatterns = rule.anti_patterns ?? [];
    if (antiPatterns.length > 0) {
      result += `Anti-patterns: ${antiPatterns.join(", ")}\n`;
    }
    result += "\n";
  }

  if (methodology.guardrails.length > 0) {
    result += "## Guardrails\n";
    for (const guard of methodology.guardrails) {
      result += `- ${guard.id}: ${guard.description}\n`;
    }
    result += "\n";
  }

  if (methodology.evaluation?.heuristics) {
    result += "## Evaluation\n";
    for (const h of methodology.evaluation.heuristics) {
      result += `- ${h.rule}: ${h.check}\n`;
    }
  }

  return result;
};

export const getMethodologyPath = (methodologyName: string, basePath?: string): string => {
  const base = basePath ?? process.cwd();
  return path.join(base, ".gates", "methodologies", `${methodologyName}.yaml`);
};