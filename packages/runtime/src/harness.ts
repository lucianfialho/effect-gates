import { Effect, Ref } from "effect";
import type { Message } from "./session-history.js";
import type { Tool } from "./tools.js";
import { runAgentLoop } from "./agent-loop.js";

// ── Functional harness definition ─────────────────────────────────────────────

export interface FunctionalHarnessDef<P = unknown, E = Record<string, string>> {
  readonly _tag: "functional";
  readonly fn: (ctx: HarnessContext<P, E>) => Effect.Effect<unknown, HarnessError>;
}

export function defineHarness<P = unknown, E = Record<string, string>>(
  fn: (ctx: HarnessContext<P, E>) => Effect.Effect<unknown, HarnessError>
): FunctionalHarnessDef<P, E> {
  return { _tag: "functional", fn };
}

// ── Context passed to functional harness ──────────────────────────────────────

export interface HarnessContext<P = unknown, E = Record<string, string>> {
  readonly payload: P;
  readonly env: E;
  readonly init: (options?: HarnessInitOptions) => Effect.Effect<HarnessSession>;
  /** Spawn a named sub-harness from the registry. Requires a HarnessRegistry. */
  readonly harness: <P2 = unknown>(name: string, payload: P2) => Effect.Effect<unknown, HarnessError>;
  /** SSE event emitter — passed to session.prompt() automatically when set */
  readonly onEvent?: (event: HarnessStreamEvent) => void;
  /** Pre-populated history from persistent store */
  readonly initialHistory?: Message[];
}

export interface HarnessInitOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly role?: string;
  /**
   * Inline system prompt — bypasses role lookup, used when the harness
   * defines its own system prompt without registering a named role.
   * Takes precedence over `role` if both are provided.
   */
  readonly systemPrompt?: string;
  /**
   * Additional tools to add on top of config.tools for this session (default).
   * When `replaceTools: true`, this completely replaces config.tools instead.
   */
  readonly tools?: Map<string, Tool>;
  /**
   * When true, `tools` replaces config.tools entirely instead of merging.
   * Use `init({ tools: new Map(), replaceTools: true })` for a tool-free session
   * (e.g. a formatter session that should only produce text).
   */
  readonly replaceTools?: boolean;
  /** Sandbox for session.shell() calls. */
  readonly sandbox?: { run: (cmd: string) => Effect.Effect<string, { code: string; message: string }> };
  /** Pre-populate the session history (e.g. loaded from a persisted store). */
  readonly initialHistory?: Message[];
  /** Default SSE event emitter for all prompt() calls on this session (overridable per-call). */
  readonly onEvent?: (event: HarnessStreamEvent) => void;
}

export interface HarnessSession {
  readonly prompt: (input: string, options?: PromptOptions) => Effect.Effect<HarnessResponse, HarnessError>;
  readonly skill: <TArgs extends Record<string, unknown>, TResult>(
    name: string,
    options: SkillOptions<TArgs, TResult>
  ) => Effect.Effect<TResult, HarnessError>;
  /** Direct sandbox access — bypasses LLM, runs command and returns output. */
  readonly shell: (command: string) => Effect.Effect<string, HarnessError>;
  /** Return the current conversation history (excluding the system message). */
  readonly getHistory: () => Effect.Effect<Message[]>;
}

/**
 * Compaction settings for a specific scope (role-level or call-level).
 */
export interface CompactionScope {
  readonly maxContextTokens?: number;
  readonly thresholdPercent?: number;
  readonly keepRecentMessages?: number;
}

export type HarnessStreamEvent =
  | { type: "tool_call";   id: string; name: string; args: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "compaction";  tokensBefore: number; tokensAfter: number; messagesBefore: number; messagesAfter: number };

export interface PromptOptions {
  readonly role?: string;
  readonly compaction?: CompactionScope | false;
  readonly onEvent?: (event: HarnessStreamEvent) => void;
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
  readonly iterations?: number;
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
  readonly compaction?: CompactionScope;
}

export interface Trigger {
  readonly type: "webhook" | "cli" | "scheduled" | "event";
  readonly handler: (context: HarnessContext) => Promise<void>;
}

export interface HarnessConfig {
  readonly provider: {
    readonly chat: (
      messages: Message[],
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
      onEvent?: (event: HarnessStreamEvent) => void
    ) => Effect.Effect<{
      content: string;
      toolCalls?: Array<{ id: string; name: string; arguments: string }>;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    }, HarnessError>;
  };
  /** Runtime tools available for agent loop tool calling. */
  readonly tools?: Map<string, Tool>;
  readonly maxToolIterations?: number;
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

const DEFAULT_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

// ── Compaction helpers ─────────────────────────────────────────────────────────

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

    const summaryText = toSummarize.map((m) => `${m.role}: ${m.content}`).join("\n\n");

    const summaryResult = yield* Effect.result(provider.chat([
      { id: crypto.randomUUID(), role: "system", content: "Summarize this conversation concisely, preserving all key facts, decisions, and context.", timestamp: Date.now() },
      { id: crypto.randomUUID(), role: "user", content: summaryText, timestamp: Date.now() },
    ]));

    if (summaryResult._tag === "Failure") return history;

    const summary: Message = {
      id: crypto.randomUUID(),
      role: "context",
      content: `[Context Summary]\n\n${summaryResult.success.content}`,
      timestamp: Date.now(),
    };

    return [summary, ...recent];
  });

// ── createHarness ──────────────────────────────────────────────────────────────

export interface HarnessRegistry {
  readonly run: <P>(
    name: string,
    payload: P,
    env: Record<string, string>,
    options?: {
      onEvent?: (event: HarnessStreamEvent) => void;
      initialHistory?: Message[];
    }
  ) => Effect.Effect<unknown, HarnessError>;
}

export const createHarness = (config: HarnessConfig, registry?: HarnessRegistry) => {
  const roles = new Map<string, Role>(
    config.roles?.map((r) => [r.name, r]) ?? [[DEFAULT_ROLE.name, DEFAULT_ROLE]]
  );

  const skills = config.skills ?? new Map();

  const init = (options?: HarnessInitOptions): Effect.Effect<HarnessSession> =>
    Effect.gen(function* () {
      // Inline systemPrompt takes precedence over role lookup
      const role: Role = options?.systemPrompt
        ? { name: "inline", systemPrompt: options.systemPrompt }
        : (roles.get(options?.role ?? DEFAULT_ROLE.name) ?? DEFAULT_ROLE);
      const historyRef = yield* Ref.make<Message[]>(options?.initialHistory ?? []);
      const sessionOnEvent = options?.onEvent;

      // Merge config tools + per-session tools (or replace if replaceTools: true)
      const sessionTools: Map<string, Tool> = options?.replaceTools
        ? (options.tools ?? new Map())
        : new Map([...(config.tools ?? new Map()), ...(options?.tools ?? new Map())]);

      const sandbox = options?.sandbox;

      const buildMessages = (history: Message[], input: string): Message[] => {
        const sys: Message = {
          id: crypto.randomUUID(),
          role: "system",
          content: role.systemPrompt,
          timestamp: Date.now(),
        };
        const user: Message = {
          id: crypto.randomUUID(),
          role: "user",
          content: input,
          timestamp: Date.now(),
        };
        return [sys, ...history, user];
      };

      const session: HarnessSession = {
        prompt: (input: string, opts?: PromptOptions) =>
          Effect.gen(function* () {
            let history = yield* Ref.get(historyRef);

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

            const messages = buildMessages(history, input);

            if (sessionTools.size > 0) {
              // ── Agent loop: LLM calls tools until it stops ───────────────
              const toolDefs = Array.from(sessionTools.values()).map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters as Record<string, unknown>,
              }));

              const activeOnEvent = opts?.onEvent ?? sessionOnEvent;

              const llmCall = (msgs: Message[]) =>
                Effect.mapError(
                  config.provider.chat(msgs, toolDefs, activeOnEvent),
                  (e: HarnessError) => new Error(e.message)
                ).pipe(
                  Effect.map((resp) => ({
                    content: resp.content,
                    toolCalls: resp.toolCalls?.map((tc) => ({
                      id: tc.id,
                      name: tc.name,
                      params: (() => { try { return JSON.parse(tc.arguments) as Record<string, unknown>; } catch { return {}; } })(),
                    })),
                    usage: resp.usage,
                  }))
                );

              // Auto-compaction: injected dependency — uses the same provider
              // Effect.result inside compactMessages means failures degrade
              // gracefully (truncation) rather than crashing the loop.
              const autoCompaction: import("./agent-loop.js").LoopCompactionConfig = {
                thresholdTokens: 30_000,
                keepRecentMessages: 8,
                summarize: (msgs: Message[]) =>
                  config.provider.chat(msgs).pipe(
                    Effect.map((r) => r.content),
                    Effect.mapError((e: HarnessError) => new Error(e.message))
                  ),
              };

              const loopResult = yield* Effect.mapError(
                runAgentLoop(llmCall, sessionTools, messages, {
                  maxIterations: config.maxToolIterations ?? 10,
                  onEvent: opts?.onEvent ?? sessionOnEvent,
                  compaction: autoCompaction,
                }),
                (e) => ({ code: "AGENT_LOOP_ERROR", message: e.message }) satisfies HarnessError
              );

              const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: input, timestamp: Date.now() };
              const assistantMsg: Message = { id: crypto.randomUUID(), role: "assistant", content: loopResult.finalContent, timestamp: Date.now() };
              yield* Ref.update(historyRef, (h) => [...h, userMsg, assistantMsg]);

              return {
                content: loopResult.finalContent,
                usage: DEFAULT_USAGE,
                iterations: loopResult.totalIterations,
              };
            }

            // ── Simple chat (no tools) ────────────────────────────────────
            const response = yield* config.provider.chat(messages);

            const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: input, timestamp: Date.now() };
            const assistantMsg: Message = { id: crypto.randomUUID(), role: "assistant", content: response.content, timestamp: Date.now() };
            yield* Ref.update(historyRef, (h) => [...h, userMsg, assistantMsg]);

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
              return yield* Effect.fail(result.failure as HarnessError);
            }

            if (opts.result) {
              return yield* opts.result.parse(result.success);
            }

            return result.success as TResult;
          }),

        shell: (command: string): Effect.Effect<string, HarnessError> => {
          if (!sandbox) {
            return Effect.fail({
              code: "NO_SANDBOX",
              message: "No sandbox configured for this session. Pass sandbox in init() options.",
            });
          }
          return Effect.mapError(
            sandbox.run(command),
            (e) => ({ code: e.code, message: e.message }) satisfies HarnessError
          );
        },

        getHistory: (): Effect.Effect<Message[]> => Ref.get(historyRef),
      };

      return session;
    });

  return { init, roles, skills };
};

// ── runHarness — execute a FunctionalHarnessDef ───────────────────────────────

export const runHarness = <P = unknown, E extends Record<string, string> = Record<string, string>>(
  def: FunctionalHarnessDef<P, E>,
  payload: P,
  env: E,
  config: HarnessConfig,
  registry?: HarnessRegistry,
  options?: {
    onEvent?: (event: HarnessStreamEvent) => void;
    initialHistory?: Message[];
  }
): Effect.Effect<unknown, HarnessError> => {
  const h = createHarness(config, registry);

  const ctx: HarnessContext<P, E> = {
    payload,
    env,
    init: h.init,
    harness: registry
      ? (name, p) => registry.run(name, p, env)
      : () => Effect.fail({ code: "NO_REGISTRY", message: "No harness registry configured. Wrap your harnesses with createHarnessRegistry()." }),
    onEvent: options?.onEvent,
    initialHistory: options?.initialHistory,
  };

  return def.fn(ctx);
};

// ── Helpers ────────────────────────────────────────────────────────────────────

export const parseResultSchema = <T>(schema: { parse: (input: unknown) => Effect.Effect<T, HarnessError> }): SkillResultSchema<T> => ({
  parse: (input: unknown) => schema.parse(input),
});

export const createSkillResultSchema = <T>(
  parse: (input: unknown) => Effect.Effect<T, HarnessError>
): SkillResultSchema<T> => ({ parse });

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
