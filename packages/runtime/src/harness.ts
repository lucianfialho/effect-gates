import { Effect, Ref } from "effect";
import type { Message } from "./session-history.js";
import type { Agent } from "./runtime.js";

export interface HarnessContext<P = unknown, E = Record<string, string>> {
  readonly payload: P;
  readonly env: E;
  readonly init: (options?: HarnessInitOptions) => Effect.Effect<HarnessSession>;
}

export interface HarnessInitOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly role?: string;
}

export interface HarnessSession {
  readonly prompt: (input: string, options?: PromptOptions) => Effect.Effect<HarnessResponse, HarnessError>;
  readonly skill: <TArgs extends Record<string, unknown>, TResult>(
    name: string,
    options: SkillOptions<TArgs, TResult>
  ) => Effect.Effect<TResult, HarnessError>;
}

export interface PromptOptions {
  readonly role?: string;
}

export interface HarnessResponse {
  readonly content: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly toolCalls?: Array<{
    name: string;
    arguments: string;
    id: string;
  }>;
}

export interface HarnessError {
  readonly code: string;
  readonly message: string;
}

export interface SkillOptions<TArgs, TResult> {
  readonly args: TArgs;
  readonly result?: SkillResultSchema<TResult>;
}

export interface SkillResultSchema<T> {
  readonly parse: (input: unknown) => Effect.Effect<T, HarnessError>;
}

export interface Role {
  readonly name: string;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly temperature?: number;
}

export interface Trigger {
  readonly type: "webhook" | "cli" | "scheduled" | "event";
  readonly handler: (context: HarnessContext) => Promise<void>;
}

export interface HarnessConfig {
  readonly provider: {
    readonly chat: (messages: Message[]) => Effect.Effect<{
      content: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    }, HarnessError>;
  };
  readonly roles?: Role[];
  readonly skills?: Map<string, SkillDefinition>;
}

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly execute: (args: Record<string, unknown>, session: HarnessSession) => Effect.Effect<unknown, HarnessError>;
}

const DEFAULT_ROLE: Role = {
  name: "default",
  systemPrompt: "You are a helpful assistant.",
};

export const createHarness = (config: HarnessConfig) => {
  const roles = new Map<string, Role>(
    config.roles?.map((r) => [r.name, r]) ?? [[DEFAULT_ROLE.name, DEFAULT_ROLE]]
  );

  const skills = config.skills ?? new Map();

  const init = (options?: HarnessInitOptions): Effect.Effect<HarnessSession> =>
    Effect.gen(function* () {
      const role = roles.get(options?.role ?? DEFAULT_ROLE.name) ?? DEFAULT_ROLE;
      const historyRef = yield* Ref.make<Message[]>([]);

      const session: HarnessSession = {
        prompt: (input: string, _opts?: PromptOptions) =>
          Effect.gen(function* () {
            const history = yield* Ref.get(historyRef);

            const systemMessage: Message = {
              id: crypto.randomUUID(),
              role: "system",
              content: role.systemPrompt,
              timestamp: Date.now(),
            };

            const userMessage: Message = {
              id: crypto.randomUUID(),
              role: "user",
              content: input,
              timestamp: Date.now(),
            };

            const messages: Message[] = [systemMessage, ...history, userMessage];
            const response = yield* config.provider.chat(messages);

            const assistantMessage: Message = {
              id: crypto.randomUUID(),
              role: "assistant",
              content: response.content,
              timestamp: Date.now(),
            };

            yield* Ref.update(historyRef, (h) => [...h, userMessage, assistantMessage]);

            return {
              content: response.content,
              usage: response.usage,
            };
          }),

        skill: <TArgs, TResult>(
          name: string,
          opts: SkillOptions<TArgs, TResult>
        ): Effect.Effect<TResult, HarnessError> =>
          Effect.gen(function* () {
            const skill = skills.get(name);
            if (!skill) {
              return yield* Effect.fail({
                code: "SKILL_NOT_FOUND" as const,
                message: `Skill "${name}" not found`,
              });
            }

            const result = yield* Effect.either(
              skill.execute(opts.args as Record<string, unknown>, session) as Effect.Effect<unknown, HarnessError>
            );

            if (result._tag === "Left") {
              const err = result.left as HarnessError;
              return yield* Effect.fail(err);
            }

            if (opts.result) {
              const validated = yield* opts.result.parse(result.right);
              return validated as TResult;
            }

            return result.right as TResult;
          }),
      };

      return session;
    });

  return {
    init,
    roles,
    skills,
  };
};

export const parseResultSchema = <T>(schema: { parse: (input: unknown) => Effect.Effect<T, HarnessError> }): SkillResultSchema<T> => ({
  parse: (input: unknown) => schema.parse(input),
});

export const createSkillResultSchema = <T>(
  parse: (input: unknown) => Effect.Effect<T, HarnessError>
): SkillResultSchema<T> => ({
  parse,
});

export const skill = <TArgs extends Record<string, unknown>, TResult>(
  name: string,
  execute: (args: TArgs, session: HarnessSession) => Effect.Effect<TResult>
): Omit<SkillDefinition, "description"> & { description?: string } => ({
  name,
  execute: (args: Record<string, unknown>, session: HarnessSession) =>
    execute(args as TArgs, session) as Effect.Effect<unknown, HarnessError>,
});

export const role = (name: string, systemPrompt: string, options?: { model?: string; temperature?: number }): Role => ({
  name,
  systemPrompt,
  ...options,
});