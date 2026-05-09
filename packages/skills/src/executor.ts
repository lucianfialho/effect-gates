import { Effect, Ref } from "effect";
import type {
  SkillConfig,
  SkillState,
  SkillTransition,
  SkillContext,
  SkillExecutor,
  SkillEvent,
  GuardCondition,
  SkillExecutorConfig,
  SkillError,
} from "./types.js";

export const MAX_TRANSITIONS = 100;

export const createSkillError = (
  code: string,
  message: string,
  state?: string
) => ({
  code,
  message,
  state,
  cause: undefined,
});

const evaluateGuard = (guard: GuardCondition, context: SkillContext): boolean => {
  if (!guard.if) return true;

  const condition = guard.if.trim();

  const severityMatch = condition.match(/^severity\s*==\s*["']?(\w+)["']?$/);
  if (severityMatch) {
    return context.metadata["severity"] === severityMatch[1];
  }

  if (condition === "tests_failed") return context.metadata["tests_failed"] === true;
  if (condition === "error") return context.errors.length > 0;
  if (condition === "success") return context.results.length > 0;

  return true;
};

const evaluateWhen = (when: string, lastOutput: unknown): boolean => {
  let normalized: Record<string, unknown> = {};

  if (typeof lastOutput === "string") {
    try {
      const parsed = JSON.parse(lastOutput.trim());
      if (parsed && typeof parsed === "object") {
        normalized = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k.replace(/[^a-zA-Z0-9_]/g, '_'), v])
        );
      }
    } catch {
      normalized = {};
    }
  } else if (lastOutput && typeof lastOutput === "object") {
    normalized = Object.fromEntries(
      Object.entries(lastOutput as Record<string, unknown>).map(([k, v]) => [k.replace(/[^a-zA-Z0-9_]/g, '_'), v])
    );
  }

  const match = when.match(/output\.(\w+)\s*([!=<>]+)\s*['"]([^'"]+)['"]/);
  if (match) {
    const [, field, op, value] = match;
    const fieldKey = field.replace(/[^a-zA-Z0-9_]/g, '_');
    const actual = normalized[fieldKey];
    switch (op) {
      case "==": return String(actual) === value;
      case "!=": return String(actual) !== value;
    }
  }

  return true;
};

const findState = (config: SkillConfig, stateId: string): SkillState | undefined =>
  config.states.find((s) => s.id === stateId);

const findTransitions = (
  config: SkillConfig,
  fromState: string
): SkillTransition[] =>
  config.transitions.filter((t) => t.from === fromState);

const evaluateTransitions = (
  config: SkillConfig,
  fromState: string,
  context: SkillContext,
  lastResult?: { success: boolean; output?: unknown }
): string | undefined => {
  const transitions = findTransitions(config, fromState);

  for (const transition of transitions) {
    if (transition.guard) {
      const passed = evaluateGuard(transition.guard, context);
      if (!passed) continue;
    }

    if (transition.when) {
      const passed = evaluateWhen(transition.when, context.lastOutput);
      if (!passed) continue;
    }

    if (transition.condition) {
      if (lastResult?.success === false && transition.condition !== "on_fail") {
        continue;
      }
      if (lastResult?.success === true && transition.condition === "on_fail") {
        continue;
      }
    }

    if (transition.guard?.skipTo) {
      return transition.guard.skipTo;
    }

    return transition.to;
  }

  const state = findState(config, fromState);
  if (!state) return undefined;

  if (lastResult?.success && state.onSuccess) {
    return state.onSuccess;
  }

  if (!lastResult?.success && state.onFail) {
    return state.onFail;
  }

  return state.onEnter;
};

const makeInitialContext = (
  skillName: string,
  input: Record<string, unknown>
): SkillContext => ({
  skillName,
  input,
  state: "",
  results: [],
  errors: [],
  metadata: {},
});

const addResult = (ctx: SkillContext, state: string, output: unknown): SkillContext => ({
  ...ctx,
  state,
  lastOutput: output,
  results: [...ctx.results, { state, output, timestamp: Date.now() }],
});

const addError = (ctx: SkillContext, state: string, error: string): SkillContext => ({
  ...ctx,
  state,
  errors: [...ctx.errors, { state, error, timestamp: Date.now() }],
});

const createEvent = (
  type: string,
  data?: unknown,
  state?: string,
  transition?: string
): SkillEvent => ({
  type: type as SkillEvent["type"],
  timestamp: Date.now(),
  data,
  state,
  transition,
});

const interpolate = (template: string, context: SkillContext): string => {
  let result = template;

  const inputMatches = template.match(/\{\{inputs\.(\w+)\}\}/g);
  if (inputMatches) {
    for (const match of inputMatches) {
      const key = match.replace("{{inputs.", "").replace("}}", "");
      const value = context.input[key];
      if (value !== undefined) {
        result = result.replace(match, String(value));
      }
    }
  }

  if (context.lastOutput !== undefined) {
    const lastOutputStr = typeof context.lastOutput === 'object' 
      ? JSON.stringify(context.lastOutput) 
      : String(context.lastOutput);

    result = result.replace(/\{\{lastOutput\}\}/g, lastOutputStr);

    if (typeof context.lastOutput === 'object') {
      const outputObj = context.lastOutput as Record<string, unknown>;
      const lastOutputFieldMatches = template.match(/\{\{lastOutput\.(\w+)\}\}/g);
      if (lastOutputFieldMatches) {
        for (const match of lastOutputFieldMatches) {
          const field = match.replace("{{lastOutput.", "").replace("}}", "");
          const value = outputObj[field];
          if (value !== undefined) {
            result = result.replace(match, String(value));
          }
        }
      }
    }
  }

  const outputMatches = template.match(/\{\{outputs\.(\w+)\}\}/g);
  if (outputMatches && context.lastOutput && typeof context.lastOutput === "object") {
    for (const match of outputMatches) {
      const field = match.replace("{{outputs.", "").replace("}}", "");
      const outputObj = context.lastOutput as Record<string, unknown>;
      const value = outputObj[field];
      if (value !== undefined) {
        result = result.replace(match, String(value));
      }
    }
  }

  const methodologyMatches = template.match(/\{\{methodology\.(\w+)\}\}/g);
  if (methodologyMatches && context.metadata.methodology) {
    const methodology = context.metadata.methodology as Record<string, unknown>;
    for (const match of methodologyMatches) {
      const key = match.replace("{{methodology.", "").replace("}}", "");
      const value = methodology[key];
      if (value !== undefined) {
        result = result.replace(match, String(value));
      }
    }
  }

  return result;
};

const interpolateParams = (
  params: Record<string, unknown> | undefined,
  context: SkillContext
): Record<string, unknown> => {
  if (!params) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      result[key] = interpolate(value, context);
    } else {
      result[key] = value;
    }
  }
  return result;
};

export const makeSkillExecutor = (
  config: SkillConfig,
  executorConfig?: SkillExecutorConfig
): Effect.Effect<SkillExecutor> =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make(config.initialState);
    const eventsRef = yield* Ref.make<SkillEvent[]>([]);
    const abortedRef = yield* Ref.make(false);

    const emitEvent = (event: SkillEvent): Effect.Effect<void> =>
      Ref.update(eventsRef, (events) => [...events, event]);

    const executeState = (
      state: SkillState,
      context: SkillContext
    ): Effect.Effect<{ output?: unknown; success: boolean }> =>
      Effect.gen(function* () {
        yield* emitEvent(createEvent("state_enter", undefined, state.id));

        if (state.tool) {
          yield* emitEvent(createEvent("tool_call", { tool: state.tool }, state.id));

          const executor = executorConfig?.executeTool ?? defaultToolExecutor;
          const mergedParams = { ...context.input, ...interpolateParams(state.params, context) };
          const result = yield* Effect.either(
            executor(state.tool, mergedParams, context).pipe(
              Effect.timeout(state.timeout ? state.timeout : 60000)
            )
          );

          if (result._tag === "Left") {
            const err = result.left;
            yield* emitEvent(createEvent("skill_error", { error: String(err) }, state.id));
            return { success: false };
          }

          yield* emitEvent(createEvent("tool_result", { result: result.right }, state.id));
          return { output: result.right, success: true };
        }

        if (state.prompt) {
          const executor = executorConfig?.executePrompt ?? defaultPromptExecutor;
          const interpolatedPrompt = interpolate(state.prompt, context);
          const result = yield* Effect.either(executor(interpolatedPrompt, context));

          if (result._tag === "Left") {
            yield* emitEvent(createEvent("skill_error", { error: String(result.left) }, state.id));
            return { success: false };
          }

          return { output: result.right, success: true };
        }

        if (state.delegateTo) {
          yield* emitEvent(createEvent("tool_call", { delegateTo: state.delegateTo, inputs: state.delegateInputs }, state.id));

          let delegateOutput: unknown;
          if (executorConfig?.delegateSkill) {
            const interpolatedInputs: Record<string, string> = {};
            if (state.delegateInputs) {
              for (const [key, value] of Object.entries(state.delegateInputs)) {
                interpolatedInputs[key] = interpolate(value, context);
              }
            }
            const result = yield* Effect.either(
              executorConfig.delegateSkill(state.delegateTo, interpolatedInputs, context)
            );
            if (result._tag === "Left") {
              yield* emitEvent(createEvent("skill_error", { error: String(result.left) }, state.id));
              return { success: false };
            }
            yield* emitEvent(createEvent("tool_result", { result: result.right }, state.id));
            delegateOutput = result.right;
          } else {
            const interpolatedInputs: Record<string, string> = {};
            if (state.delegateInputs) {
              for (const [key, value] of Object.entries(state.delegateInputs)) {
                interpolatedInputs[key] = interpolate(value, context);
              }
            }
            delegateOutput = { delegated: state.delegateTo, inputs: interpolatedInputs };
          }

          return { output: delegateOutput, success: true };
        }

        return { success: true };
      });

    const execute = (input: Record<string, unknown>): Effect.Effect<SkillContext, SkillError> =>
      Effect.gen(function* () {
        let context = makeInitialContext(config.name, input);

        yield* emitEvent(createEvent("skill_start", { input }, config.initialState));

        let transitionCount = 0;
        const maxTransitions = executorConfig?.maxTransitions ?? MAX_TRANSITIONS;

        while (transitionCount < maxTransitions) {
          const isAborted = yield* Ref.get(abortedRef);
          if (isAborted) {
            yield* emitEvent(createEvent("skill_end", { aborted: true }));
            return context;
          }

          const currentStateId = yield* Ref.get(stateRef);
          const state = findState(config, currentStateId);

          if (!state) {
            yield* emitEvent(createEvent("skill_end", { error: "state_not_found" }));
            return yield* Effect.fail(createSkillError(
              "STATE_NOT_FOUND",
              `State "${currentStateId}" not found in skill "${config.name}"`,
              currentStateId
            ));
          }

          const { output, success } = yield* executeState(state, context);

          if (output !== undefined) {
            context = addResult(context, state.id, output);
          }

          if (!success) {
            context = addError(context, state.id, "State execution failed");
          }

          yield* emitEvent(createEvent("state_exit", undefined, state.id));

          const nextState = evaluateTransitions(config, currentStateId, context, { success, output });

          if (!nextState) {
            yield* emitEvent(createEvent("skill_end", { completed: true, state: currentStateId }));
            return context;
          }

          yield* emitEvent(createEvent("transition", { to: nextState }, currentStateId, nextState));
          yield* Ref.set(stateRef, nextState);
          transitionCount++;
        }

        yield* emitEvent(createEvent("skill_end", { max_transitions: true }));
        return yield* Effect.fail(createSkillError(
          "TRANSITION_FAILED",
          `Skill "${config.name}" exceeded max transitions (${executorConfig?.maxTransitions ?? MAX_TRANSITIONS})`
        ));
      });

    const getState = (): Effect.Effect<string> => Ref.get(stateRef);

    const getEvents = (): Effect.Effect<SkillEvent[]> => Ref.get(eventsRef);

    const abort = (): Effect.Effect<void> => Ref.set(abortedRef, true);

    return { execute, getState, getEvents, abort };
  });

const defaultToolExecutor = (
  toolName: string,
  _params: Record<string, unknown>,
  _context: SkillContext
): Effect.Effect<unknown> =>
  Effect.succeed({ executed: toolName, status: "simulated" });

const defaultPromptExecutor = (
  prompt: string,
  _context: SkillContext
): Effect.Effect<unknown> =>
  Effect.succeed(`Executed prompt: ${prompt.substring(0, 50)}...`);

export const createSkillFromYaml = (yaml: Record<string, unknown>): SkillConfig => ({
  name: yaml.name as string,
  description: yaml.description as string | undefined,
  version: yaml.version as string | undefined,
  initialState: yaml.initialState as string,
  states: (yaml.states as SkillState[]) ?? [],
  transitions: (yaml.transitions as { from: string; to: string; condition?: string }[]) ?? [],
  contextSchema: yaml.contextSchema as Record<string, unknown> | undefined,
});

export const validateSkillConfig = (config: SkillConfig): SkillError[] => {
  const errors: { code: string; message: string; state?: string }[] = [];

  if (!config.name) {
    errors.push(createSkillError("INVALID_CONFIG", "Skill name is required"));
  }

  if (!config.initialState) {
    errors.push(createSkillError("INVALID_CONFIG", "Initial state is required"));
  }

  const stateIds = config.states.map((s) => s.id);
  if (!stateIds.includes(config.initialState)) {
    errors.push(createSkillError(
      "INVALID_CONFIG",
      `Initial state "${config.initialState}" not found in states`
    ));
  }

  for (const state of config.states) {
    if (state.onEnter && !stateIds.includes(state.onEnter)) {
      errors.push(createSkillError(
        "INVALID_CONFIG",
        `State "${state.id}" references non-existent onEnter state "${state.onEnter}"`
      ));
    }
    if (state.onSuccess && !stateIds.includes(state.onSuccess)) {
      errors.push(createSkillError(
        "INVALID_CONFIG",
        `State "${state.id}" references non-existent onSuccess state "${state.onSuccess}"`
      ));
    }
    if (state.onFail && !stateIds.includes(state.onFail)) {
      errors.push(createSkillError(
        "INVALID_CONFIG",
        `State "${state.id}" references non-existent onFail state "${state.onFail}"`
      ));
    }
  }

  for (const transition of config.transitions) {
    if (!stateIds.includes(transition.from)) {
      errors.push(createSkillError(
        "INVALID_CONFIG",
        `Transition from non-existent state "${transition.from}"`
      ));
    }
    if (!stateIds.includes(transition.to)) {
      errors.push(createSkillError(
        "INVALID_CONFIG",
        `Transition to non-existent state "${transition.to}"`
      ));
    }
  }

  return errors;
};