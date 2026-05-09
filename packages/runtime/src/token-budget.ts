import { Effect, Ref } from "effect";

export interface TokenBudget {
  readonly used: number;
  readonly budget: number;
  readonly reservedForResponse: number;
  readonly available: number;
  readonly usagePercent: number;
}

export interface TokenBudgetConfig {
  readonly maxContextTokens: number;
  readonly reservedForResponse: number;
  readonly compactionThresholdPercent: number;
}

export const defaultTokenBudgetConfig: TokenBudgetConfig = {
  maxContextTokens: 128000,
  reservedForResponse: 4000,
  compactionThresholdPercent: 80,
};

const estimateTokenCount = (text: string): number => {
  return Math.ceil(text.length / 4);
};

const estimateMessagesTokens = (messages: { content: string; role: string }[]): number => {
  return messages.reduce((sum, m) => sum + estimateTokenCount(m.content) + 10, 0);
};

interface BudgetTracker {
  getBudget(): Effect.Effect<TokenBudget>;
  addUsage(inputTokens: number, outputTokens: number): Effect.Effect<void>;
  addMessages(messages: { content: string; role: string }[]): Effect.Effect<void>;
  reset(): Effect.Effect<void>;
  shouldCompact(): Effect.Effect<boolean>;
  getEntryCount(): Effect.Effect<number>;
  incrementEntryCount(): Effect.Effect<void>;
}

export const makeTokenBudgetTracker = (
  config: TokenBudgetConfig = defaultTokenBudgetConfig
): Effect.Effect<BudgetTracker> =>
  Effect.gen(function* () {
    const tokensRef = yield* Ref.make(0);
    const entryCountRef = yield* Ref.make(0);

    const getBudget = (): Effect.Effect<TokenBudget> =>
      Effect.map(Ref.get(tokensRef), (used) => {
        const available = config.maxContextTokens - config.reservedForResponse - used;
        const usagePercent = (used / (config.maxContextTokens - config.reservedForResponse)) * 100;
        return {
          used,
          budget: config.maxContextTokens,
          reservedForResponse: config.reservedForResponse,
          available: Math.max(0, available),
          usagePercent,
        };
      });

    const addUsage = (inputTokens: number, outputTokens: number): Effect.Effect<void> =>
      Ref.update(tokensRef, (n) => n + inputTokens + outputTokens);

    const addMessages = (messages: { content: string; role: string }[]): Effect.Effect<void> =>
      Ref.update(tokensRef, (n) => n + estimateMessagesTokens(messages));

    const reset = (): Effect.Effect<void> => Ref.set(tokensRef, 0);

    const shouldCompact = (): Effect.Effect<boolean> =>
      Effect.map(getBudget(), (budget) => budget.usagePercent >= config.compactionThresholdPercent);

    const getEntryCount = (): Effect.Effect<number> => Ref.get(entryCountRef);

    const incrementEntryCount = (): Effect.Effect<void> =>
      Ref.update(entryCountRef, (n) => n + 1);

    return { getBudget, addUsage, addMessages, reset, shouldCompact, getEntryCount, incrementEntryCount };
  });

export const estimateTokens = (text: string): number => estimateTokenCount(text);

export const estimateMessagesTokensCount = (messages: { content: string; role: string }[]): number =>
  estimateMessagesTokens(messages);