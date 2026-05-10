import { Effect, Ref } from "effect";
import {
  SessionHistory,
  makeInMemorySessionStore,
  type Message,
  type SessionData,
} from "./session-history.js";
import {
  createCompactionTrigger,
  runCompaction,
  type CompactionConfig,
  type CompactionResult,
} from "./compaction.js";
import {
  makeTokenBudgetTracker,
  defaultTokenBudgetConfig,
  estimateMessagesTokensCount,
  type TokenBudget,
  type TokenBudgetConfig,
} from "./token-budget.js";
import type {
  ChatResponse,
  ProviderError,
} from "@gatesai/providers";

export type { ChatResponse, ProviderError };

export interface AgentConfig {
  readonly model: string;
  readonly provider: Provider;
  readonly systemPrompt?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly compactionConfig?: CompactionConfig;
  readonly tokenBudgetConfig?: TokenBudgetConfig;
}

export interface Provider {
  readonly id: string;
  readonly chat: (messages: Message[]) => Effect.Effect<ChatResponse, ProviderError>;
}

export interface Session {
  readonly id: string;
  readonly createdAt: number;
  readonly messages: Message[];
  readonly metadata: Record<string, string>;
}

export interface AgentResponse {
  readonly content: string;
  readonly session: Session;
  readonly usage: ChatResponse["usage"];
  readonly cost: number;
  readonly compaction?: CompactionResult;
  readonly budget?: TokenBudget;
}

export interface AgentError {
  readonly code: "SESSION_NOT_FOUND" | "PROVIDER_ERROR" | "INVALID_INPUT" | "COMPACTION_ERROR";
  readonly message: string;
}

export interface Agent {
  run(input: string): Effect.Effect<AgentResponse, AgentError>;
  resume(sessionId: string, input: string): Effect.Effect<AgentResponse, AgentError>;
  getHistory(sessionId: string): Effect.Effect<SessionHistory, AgentError>;
  deleteSession(sessionId: string): Effect.Effect<void, AgentError>;
  getBudget(sessionId: string): Effect.Effect<TokenBudget | null>;
}

interface BudgetTracker {
  getBudget(): Effect.Effect<TokenBudget>;
  addUsage(inputTokens: number, outputTokens: number): Effect.Effect<void>;
  addMessages(messages: { content: string; role: string }[]): Effect.Effect<void>;
  reset(): Effect.Effect<void>;
  shouldCompact(): Effect.Effect<boolean>;
  getEntryCount(): Effect.Effect<number>;
  incrementEntryCount(): Effect.Effect<void>;
}

interface SessionState {
  readonly history: SessionHistory;
  readonly budget: BudgetTracker;
  readonly storageKey: string;
  readonly createdAt: number;
}

const mapProviderError = (e: ProviderError): AgentError => ({
  code: "PROVIDER_ERROR",
  message: e.message,
});

export const makeAgent = (config: AgentConfig): Effect.Effect<Agent> =>
  Effect.gen(function* () {
    const defaultSessionId = crypto.randomUUID();
    const store = yield* makeInMemorySessionStore();
    const sessions = yield* Ref.make(new Map<string, SessionState>());
    const tokenBudgetConfig = config.tokenBudgetConfig ?? defaultTokenBudgetConfig;
    const compactionConfig = config.compactionConfig ?? {
      thresholdTokens: 15000,
      maxEntriesBeforeCompaction: 100,
      budgetAware: true,
      compactionThresholdPercent: 80,
    };

    const createSessionState = (
      sessionId: string
    ): Effect.Effect<SessionState> =>
      Effect.gen(function* () {
        const storageKey = `agent-session:${sessionId}`;
        const existingData = yield* store.load(storageKey);
        const history = yield* SessionHistory.fromData(existingData);
        const budget = yield* makeTokenBudgetTracker(tokenBudgetConfig);

        return {
          history,
          budget,
          storageKey,
          createdAt: existingData?.createdAt
            ? new Date(existingData.createdAt).getTime()
            : Date.now(),
        };
      });

    const getOrCreateSessionState = (
      sessionId: string,
      create: boolean
    ): Effect.Effect<SessionState, AgentError> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessions);
        const existing = map.get(sessionId);

        if (existing) {
          return existing;
        }

        if (!create) {
          return yield* Effect.fail({
            code: "SESSION_NOT_FOUND" as const,
            message: `Session "${sessionId}" not found`,
          });
        }

        const state = yield* createSessionState(sessionId);

        yield* Ref.update(sessions, (m) => {
          const newMap = new Map(m);
          newMap.set(sessionId, state);
          return newMap;
        });

        return state;
      });

    const persistHistory = (state: SessionState): Effect.Effect<void> =>
      Effect.gen(function* () {
        const data = yield* state.history.toData({});
        yield* store.save(state.storageKey, data);
      });

    const buildContextMessages = (
      history: SessionHistory,
    ): Effect.Effect<Message[]> =>
      Effect.gen(function* () {
        const contextMessages = yield* history.buildContext();

        const systemMessages: Message[] = config.systemPrompt
          ? [{
              id: crypto.randomUUID(),
              role: "system" as const,
              content: config.systemPrompt,
              timestamp: Date.now()
            }]
          : [];

        return [...systemMessages, ...contextMessages];
      });

    const run = (input: string): Effect.Effect<AgentResponse, AgentError> =>
      Effect.gen(function* () {
        const sessionId = defaultSessionId;
        const state = yield* getOrCreateSessionState(sessionId, true);

        const userMessage: Message = {
          id: crypto.randomUUID(),
          role: "user",
          content: input,
          timestamp: Date.now(),
        };

        yield* state.history.appendMessage(userMessage, "user");
        yield* state.budget.incrementEntryCount();

        const messages = yield* buildContextMessages(state.history);
        const estimatedTokens = estimateMessagesTokensCount(messages);
        yield* state.budget.addMessages(messages);

        const response = yield* Effect.mapError(config.provider.chat(messages), mapProviderError);

        yield* state.budget.addUsage(response.usage.inputTokens, response.usage.outputTokens);

        const assistantMessage: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: response.content,
          timestamp: Date.now(),
        };

        yield* state.history.appendMessage(assistantMessage, "prompt");

        yield* persistHistory(state);

        const budget = yield* state.budget.getBudget();
        const trigger = createCompactionTrigger(compactionConfig, {
          shouldCompact: () => state.budget.shouldCompact(),
          getEntryCount: () => state.budget.getEntryCount(),
          getBudget: () => state.budget.getBudget(),
        });

        const { shouldCompact, triggeredBy } = yield* trigger.trigger(
          estimatedTokens,
          yield* state.budget.getEntryCount()
        );

        let compactionResult: CompactionResult | undefined;

        if (shouldCompact) {
          // SessionHistory satisfies the structural type runCompaction expects —
          // no cast needed; the provider error channel is mapped to CompactionError.
          const compaction = runCompaction(state.history, {
            modelId: config.model,
            provider: { chat: (messages: Message[]) => config.provider.chat(messages) },
            systemPrompt: config.systemPrompt,
            triggeredBy: triggeredBy ?? "budget",
          });

          const result = yield* Effect.result(compaction);

          if (result._tag === "Success") {
            compactionResult = result.success;
          }
        }

        const allMessages = yield* state.history.buildContext();
        const session: Session = {
          id: sessionId,
          createdAt: state.createdAt,
          messages: allMessages.map(m => ({
            id: m.id,
            role: m.role === "context" ? "system" : m.role,
            content: m.content,
            timestamp: m.timestamp,
          })),
          metadata: {},
        };

        return {
          content: response.content,
          session,
          usage: response.usage,
          cost: response.cost ?? 0,
          compaction: compactionResult,
          budget,
        };
      });

    const resume = (sessionId: string, input: string): Effect.Effect<AgentResponse, AgentError> =>
      Effect.gen(function* () {
        const state = yield* getOrCreateSessionState(sessionId, false);

        const userMessage: Message = {
          id: crypto.randomUUID(),
          role: "user",
          content: input,
          timestamp: Date.now(),
        };

        yield* state.history.appendMessage(userMessage, "user");
        yield* state.budget.incrementEntryCount();

        const messages = yield* buildContextMessages(state.history);
        const estimatedTokens = estimateMessagesTokensCount(messages);
        yield* state.budget.addMessages(messages);

        const response = yield* Effect.mapError(config.provider.chat(messages), mapProviderError);

        yield* state.budget.addUsage(response.usage.inputTokens, response.usage.outputTokens);

        const assistantMessage: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: response.content,
          timestamp: Date.now(),
        };

        yield* state.history.appendMessage(assistantMessage, "prompt");

        yield* persistHistory(state);

        const budget = yield* state.budget.getBudget();

        const allMessages = yield* state.history.buildContext();
        const session: Session = {
          id: sessionId,
          createdAt: state.createdAt,
          messages: allMessages.map(m => ({
            id: m.id,
            role: m.role === "context" ? "system" : m.role,
            content: m.content,
            timestamp: m.timestamp,
          })),
          metadata: {},
        };

        return {
          content: response.content,
          session,
          usage: response.usage,
          cost: response.cost ?? 0,
          budget,
        };
      });

    const getHistory = (sessionId: string): Effect.Effect<SessionHistory, AgentError> =>
      Effect.map(getOrCreateSessionState(sessionId, false), (state) => state.history);

    const deleteSession = (sessionId: string): Effect.Effect<void, AgentError> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessions);
        const state = map.get(sessionId);

        if (state) {
          yield* store.delete(state.storageKey);
        }

        yield* Ref.update(sessions, (m) => {
          const newMap = new Map(m);
          newMap.delete(sessionId);
          return newMap;
        });
      });

    const getBudget = (sessionId: string): Effect.Effect<TokenBudget | null> =>
      Effect.flatMap(Ref.get(sessions), (map) => {
        const state = map.get(sessionId);
        if (!state) return Effect.succeed(null);
        return state.budget.getBudget();
      });

    return { run, resume, getHistory, deleteSession, getBudget };
  });