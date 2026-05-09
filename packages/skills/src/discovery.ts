import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import yaml from "js-yaml";
import type { SkillConfig, SkillState, SkillTransition, GuardCondition } from "./types.js";

export interface DiscoveredSkill {
  readonly name: string;
  readonly path: string;
  readonly config: SkillConfig;
  readonly files: {
    skillYaml?: string;
    skillMd?: string;
    schemas?: string[];
  };
}

export const discoverSkills = (
  basePath: string,
  options?: {
    recursive?: boolean;
    maxDepth?: number;
  }
): Effect.Effect<DiscoveredSkill[], Error> =>
  Effect.tryPromise({
    try: async () => {
      const skills: DiscoveredSkill[] = [];
      const maxDepth = options?.maxDepth ?? 3;

      const scanDir = async (dirPath: string, depth: number): Promise<void> => {
        if (depth > maxDepth) return;

        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);

          if (entry.isDirectory()) {
            const skillYamlPath = path.join(fullPath, "skill.yaml");

            try {
              await fs.promises.access(skillYamlPath);
              const yamlContent = await fs.promises.readFile(skillYamlPath, "utf-8");
              const parsed = parseSkillYaml(yamlContent);

              const schemasDir = path.join(fullPath, "schemas");
              let schemas: string[] = [];
              try {
                const schemaEntries = await fs.promises.readdir(schemasDir);
                schemas = schemaEntries
                  .filter((f) => f.endsWith(".schema.json"))
                  .map((f) => path.join(schemasDir, f));
              } catch {
                // no schemas dir
              }

              let skillMdPath: string | undefined;
              try {
                await fs.promises.access(path.join(fullPath, "SKILL.md"));
                skillMdPath = path.join(fullPath, "SKILL.md");
              } catch {
                // no SKILL.md
              }

              skills.push({
                name: parsed.name ?? entry.name,
                path: fullPath,
                config: parsed,
                files: {
                  skillYaml: skillYamlPath,
                  skillMd: skillMdPath,
                  schemas,
                },
              });
            } catch {
              // skill.yaml not found in this dir, maybe recurse
              if (options?.recursive) {
                await scanDir(fullPath, depth + 1);
              }
            }
          }
        }
      };

      await scanDir(basePath, 0);
      return skills;
    },
    catch: (e) => new Error(`Failed to discover skills: ${e}`),
  });

interface RawSkillYaml {
  name?: string;
  description?: string;
  version?: string;
  initialState?: string;
  states?: Array<Record<string, unknown>>;
  transitions?: Array<Record<string, unknown>>;
  methodology?: string;
}

const parseSkillYaml = (content: string): SkillConfig => {
  const raw = yaml.load(content) as RawSkillYaml;

  const states: SkillState[] = (raw.states ?? []).map((s) => ({
    id: String(s["id"] ?? ""),
    description: s["description"] ? String(s["description"]) : undefined,
    tool: s["tool"] ? String(s["tool"]) : undefined,
    params: s["params"] as Record<string, unknown> | undefined,
    prompt: s["prompt"] ? String(s["prompt"]) : undefined,
    delegateTo: s["delegate_to"] ? String(s["delegate_to"]) : undefined,
    delegateInputs: s["delegate_inputs"] as Record<string, string> | undefined,
    methodology: s["methodology"] ? String(s["methodology"]) : undefined,
    timeout: s["timeout"] ? Number(s["timeout"]) : undefined,
    onEnter: s["onEnter"] ? String(s["onEnter"]) : undefined,
    onSuccess: s["onSuccess"] ? String(s["onSuccess"]) : undefined,
    onFail: s["onFail"] ? String(s["onFail"]) : undefined,
    guards: s["guards"] as GuardCondition[] | undefined,
  }));

  const transitions: SkillTransition[] = (raw.transitions ?? []).map((t) => ({
    from: String(t["from"] ?? ""),
    to: String(t["to"] ?? ""),
    when: t["when"] ? String(t["when"]) : undefined,
    condition: t["condition"] ? String(t["condition"]) : undefined,
    guard: t["guard"] as GuardCondition | undefined,
  }));

  return {
    name: raw.name ?? "unnamed",
    description: raw.description,
    version: raw.version ?? "1.0.0",
    initialState: raw.initialState ?? states[0]?.id ?? "start",
    states,
    transitions,
    methodology: raw.methodology,
  };
};

export const loadSkillFromDirectory = (
  dirPath: string
): Effect.Effect<DiscoveredSkill, Error> =>
  Effect.gen(function* () {
    const skillYamlPath = path.join(dirPath, "skill.yaml");

    const exists = yield* Effect.tryPromise(() =>
      fs.promises.access(skillYamlPath).then(() => true).catch(() => false)
    );

    if (!exists) {
      return yield* Effect.fail(new Error(`No skill.yaml found in ${dirPath}`));
    }

    const content = yield* Effect.tryPromise(() =>
      fs.promises.readFile(skillYamlPath, "utf-8")
    );

    const config = parseSkillYaml(content);

    const skillMdExists = yield* Effect.tryPromise(() =>
      fs.promises.access(path.join(dirPath, "SKILL.md")).then(() => true).catch(() => false)
    );

    return {
      name: config.name,
      path: dirPath,
      config,
      files: {
        skillYaml: skillYamlPath,
        skillMd: skillMdExists ? path.join(dirPath, "SKILL.md") : undefined,
        schemas: [],
      },
    };
  });

export const getSkillPath = (skillName: string, basePath: string): string =>
  path.join(basePath, skillName);