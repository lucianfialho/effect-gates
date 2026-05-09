import { Effect } from "effect";

export type GuardCondition = {
  if: string;
  skipTo?: string;
};

export type StateResult = {
  success: boolean;
  output?: unknown;
  error?: string;
};

export type TransitionResult = {
  matched: boolean;
  targetState?: string;
  guard?: GuardCondition;
};

export interface SkillState {
  readonly id: string;
  readonly description?: string;
  readonly tool?: string;
  readonly params?: Record<string, unknown>;
  readonly prompt?: string;
  readonly delegateTo?: string;
  readonly delegateInputs?: Record<string, string>;
  readonly methodology?: string;
  readonly timeout?: number;
  readonly onEnter?: string;
  readonly onSuccess?: string;
  readonly onFail?: string;
  readonly guards?: GuardCondition[];
}

export interface Methodology {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly rules: MethodologyRule[];
  readonly patterns: Record<string, unknown>;
  readonly guardrails: MethodologyGuardrail[];
  readonly evaluation?: MethodologyEvaluation;
}

export interface MethodologyRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly examples?: Array<{ before: string; after: string }>;
  readonly patterns?: string[];
  readonly anti_patterns?: string[];
}

export interface MethodologyGuardrail {
  readonly id: string;
  readonly description: string;
}

export interface MethodologyEvaluation {
  readonly heuristics?: Array<{ rule: string; check: string }>;
}

export interface SkillTransition {
  readonly from: string;
  readonly to: string;
  readonly when?: string;
  readonly condition?: string;
  readonly guard?: GuardCondition;
}

export interface SkillConfig {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly initialState: string;
  readonly states: SkillState[];
  readonly transitions: SkillTransition[];
  readonly methodology?: string;
  readonly contextSchema?: Record<string, unknown>;
}

export interface SkillContext {
  readonly skillName: string;
  readonly input: Record<string, unknown>;
  readonly state: string;
  readonly lastOutput?: unknown;
  readonly results: Array<{
    state: string;
    output: unknown;
    timestamp: number;
  }>;
  readonly errors: Array<{
    state: string;
    error: string;
    timestamp: number;
  }>;
  readonly metadata: Record<string, unknown>;
  readonly methodologyContext?: string;
}

export interface SkillExecution {
  readonly skill: SkillConfig;
  readonly context: SkillContext;
  readonly events: SkillEvent[];
}

export interface SkillExecutor {
  readonly execute: (input: Record<string, unknown>) => Effect.Effect<SkillContext, SkillError>;
  readonly getState: () => Effect.Effect<string>;
  readonly getEvents: () => Effect.Effect<SkillEvent[]>;
  readonly abort: () => Effect.Effect<void>;
}

export interface SkillExecutorConfig {
  readonly executeTool?: (
    toolName: string,
    params: Record<string, unknown>,
    context: SkillContext
  ) => Effect.Effect<unknown, Error>;
  readonly executePrompt?: (
    prompt: string,
    context: SkillContext
  ) => Effect.Effect<unknown, Error>;
  readonly delegateSkill?: (
    skillName: string,
    inputs: Record<string, string>,
    context: SkillContext
  ) => Effect.Effect<unknown, Error>;
  readonly maxTransitions?: number;
}

export interface SkillError {
  readonly code: string;
  readonly message: string;
  readonly state?: string;
  readonly cause?: unknown;
}

export const SkillErrorCodes = {
  StateNotFound: "STATE_NOT_FOUND",
  TransitionFailed: "TRANSITION_FAILED",
  GuardFailed: "GUARD_FAILED",
  ToolFailed: "TOOL_FAILED",
  Timeout: "TIMEOUT",
  NoTransition: "NO_TRANSITION",
  InvalidConfig: "INVALID_CONFIG",
} as const;

export interface SkillEvent {
  readonly type: SkillEventType;
  readonly timestamp: number;
  readonly state?: string;
  readonly transition?: string;
  readonly data?: unknown;
}

export type SkillEventType =
  | "skill_start"
  | "skill_end"
  | "state_enter"
  | "state_exit"
  | "transition"
  | "guard_passed"
  | "guard_failed"
  | "tool_call"
  | "tool_result"
  | "skill_error";