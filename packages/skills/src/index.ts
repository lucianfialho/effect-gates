import { Effect, Ref } from "effect";
import type { SkillError } from "./types.js";
import type { SkillContext as SkillContextType, SkillConfig, SkillState, SkillTransition, SkillExecutor, SkillEvent, GuardCondition, SkillExecutorConfig } from "./types.js";

export { SkillError } from "./types.js";

export type { SkillContextType as SkillContext };

export interface SkillRuntimeContext {
  readonly workingDirectory: string;
  readonly environment: Record<string, string>;
  readonly sessionId: string;
}

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly execute: (input: SkillInput) => Effect.Effect<SkillOutput, SkillError>;
}

export interface SkillInput {
  readonly params: Record<string, string>;
  readonly context: SkillRuntimeContext;
}

export interface SkillOutput {
  readonly result: string;
  readonly metadata?: Record<string, string>;
}

export class SkillNotFoundError {
  readonly _tag = "SkillNotFoundError";
  constructor(readonly skillName: string) {}
}

interface SkillRunnerImpl {
  run: (skillName: string, input: SkillInput) => Effect.Effect<SkillOutput, SkillNotFoundError | SkillError>;
  register: (skill: Skill) => Effect.Effect<void>;
  list: () => Effect.Effect<Skill[]>;
}

export const makeSkillRunner = (): Effect.Effect<SkillRunnerImpl> =>
  Effect.gen(function* () {
    const skillsRef = yield* Ref.make(new Map<string, Skill>());

    const run = (skillName: string, input: SkillInput): Effect.Effect<SkillOutput, SkillNotFoundError | SkillError> =>
      Effect.gen(function* () {
        const skillsMap = yield* Ref.get(skillsRef);
        const skill = skillsMap.get(skillName);

        if (!skill) {
          return yield* Effect.fail(new SkillNotFoundError(skillName));
        }

        return yield* skill.execute(input);
      });

    const register = (skill: Skill): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(skillsRef, (map) => {
          const newMap = new Map(map);
          newMap.set(skill.name, skill);
          return newMap;
        });
      });

    const list = (): Effect.Effect<Skill[]> =>
      Effect.map(Ref.get(skillsRef), (map) => Array.from(map.values()));

    return { run, register, list };
  });

export type SkillRunner = SkillRunnerImpl;

export type {
  SkillConfig,
  SkillState,
  SkillTransition,
  SkillExecutor,
  SkillEvent,
  GuardCondition,
  SkillExecutorConfig,
  Methodology,
  MethodologyRule,
  MethodologyGuardrail,
} from "./types.js";

export { makeSkillExecutor, createSkillFromYaml, validateSkillConfig } from "./executor.js";

export { interpolateTemplate, processConditionals, evaluateCondition, injectFiles, resolveContextValue } from "./interpolate.js";
export type { InterpolateOptions } from "./interpolate.js";

export type { DiscoveredSkill } from "./discovery.js";
export { discoverSkills, loadSkillFromDirectory, getSkillPath } from "./discovery.js";

export { createSandboxToolExecutor, runSkillWithSandbox, createSkillExecutorWithSandbox, getBuiltInTools, createLLMAwareExecutor } from "./skill-tools.js";
export { skillToolNames, isSkillTool } from "./skill-tools.js";
export type { SkillToolName } from "./skill-tools.js";

export { loadMethodology, formatMethodologyForPrompt, getMethodologyPath } from "./methodology.js";
export type { LoadedMethodology } from "./methodology.js";

export { loadConnector, loadConnectors } from "./connectors.js";
export type { Connector, ConnectorRegistry } from "./connectors.js";

export { makeTaskQueue, makeFileTaskQueue, makeTaskRunner } from "./tasks.js";
export type { Task, TaskStatus, TaskError, TaskStats, TaskQueue, TaskRunner, TaskRunnerOptions } from "./tasks.js";