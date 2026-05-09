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

/**
 * Compaction settings for a specific scope (role-level or call-level).
 * When the harness history exceeds the threshold, the LLM is called to
 * summarize the older messages before the next prompt is sent.
 */
export interface CompactionScope {
  /** Trigger compaction when estimated tokens exceed this value (default: 8000) */
  readonly maxContextTokens?: number;
  /** Percentage of maxContextTokens that triggers compaction (0–100, default: 80) */
  readonly thresholdPercent?: number;
  /** How many of the most recent messages to keep verbatim after summarising (default: 4) */
  readonly keepRecentMessages?: number;
}

export interface PromptOptions {
  readonly role?: string;
  /**
   * Override the compaction scope for this single call.
   * Pass `false` to disable compaction even if the role has one configured.
   */
  readonly compaction?: CompactionScope | false;
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
  /** Default compaction scope for every prompt using this role */
  readonly compaction?: CompactionScope;
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

// ── Compaction helpers ──────────────────────────────────────────────────────

const estimateTokens = (messages: Message[]): number =>
  messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 4, 0);

const applyCompaction = (
  history: Message[],
  scope: CompactionScope,
  provider: HarnessConfig["provider"]
): Effect.Effect<Message[]> =>
  Effect.gen(function* () {
    const maxTokens = scope.maxContextTokens ?? 8000;
    const threshold = maxTokens * ((scope.thresholdPercent ?? 80) / 100);

    if (estimateTokens(history) < threshold) return history;

    const keepRecent = scope.keepRecentMessages ?? 4;
    const toSummarize = history.slice(0, Math.max(0, history.length - keepRecent));
    const recent = history.slice(-Math.min(keepRecent, history.length));

    if (toSummarize.length === 0) return history;

    const summaryText = toSummarize
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const summaryResult = yield* Effect.result(provider.chat([
      {
        id: crypto.randomUUID(),
        role: "system",
        content: "Summarize this conversation concisely, preserving all key facts, decisions, and context.",
        timestamp: Date.now(),
      },
      {
        id: crypto.randomUUID(),
        role: "user",
        content: summaryText,
        timestamp: Date.now(),
      },
    ]));

    // If summarisation fails, return history unchanged rather than crashing
    if (summaryResult._tag === "Failure") return history;

    const summary: Message = {
      id: crypto.randomUUID(),
      role: "context",
      content: `[Context Summary]\n\n${summaryResult.success.content}`,
      timestamp: Date.now(),
    };

    return [summary, ...recent];
  });

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
        prompt: (input: string, opts?: PromptOptions) =>
          Effect.gen(function* () {
            let history = yield* Ref.get(historyRef);

            // Resolve active scope: call-level > role-level > none
            const activeScope =
              opts?.compaction !== false
                ? (opts?.compaction ?? role.compaction)
                : undefined;

            if (activeScope) {
              const compacted = yield* applyCompaction(history, activeScope, config.provider);
              if (compacted !== history) {
                yield* Ref.set(historyRef, compacted);
                history = compacted;
              }
            }

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

            const result = yield* Effect.result(
              skill.execute(opts.args as Record<string, unknown>, session) as Effect.Effect<unknown, HarnessError>
            );

            if (result._tag === "Failure") {
              const err = result.failure as HarnessError;
              return yield* Effect.fail(err);
            }

            if (opts.result) {
              const validated = yield* opts.result.parse(result.success);
              return validated as TResult;
            }

            return result.success as TResult;
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

export const role = (
  name: string,
  systemPrompt: string,
  options?: { model?: string; temperature?: number; compaction?: CompactionScope }
): Role => ({
  name,
  systemPrompt,
  ...options,
});