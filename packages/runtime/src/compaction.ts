import { Effect } from "effect";
import type { Message } from "./session-history.js";
import type { TokenBudget } from "./token-budget.js";

export interface CompactionConfig {
  readonly thresholdTokens: number;
  readonly maxEntriesBeforeCompaction: number;
  readonly budgetAware?: boolean;
  readonly compactionThresholdPercent?: number;
}

export interface CompactionResult {
  readonly compacted: boolean;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly summary: string;
  readonly triggeredBy: "threshold" | "budget" | "entry_count";
}

export class CompactionError {
  readonly _tag = "CompactionError";
  constructor(
    readonly message: string,
    readonly cause?: unknown
  ) {}
}

export const defaultCompactionConfig: CompactionConfig = {
  thresholdTokens: 15000,
  maxEntriesBeforeCompaction: 100,
  budgetAware: true,
  compactionThresholdPercent: 80,
};

export const createCompactionTrigger = (
  config: CompactionConfig = defaultCompactionConfig,
  budgetTracker?: {
    shouldCompact(): Effect.Effect<boolean>;
    getEntryCount(): Effect.Effect<number>;
    getBudget(): Effect.Effect<TokenBudget>;
  }
) => {
  const shouldCompactByThreshold = (tokens: number, entryCount: number): boolean =>
    tokens >= config.thresholdTokens || entryCount >= config.maxEntriesBeforeCompaction;

  const trigger = (
    tokens: number,
    entryCount: number
  ): Effect.Effect<{ shouldCompact: boolean; triggeredBy: "threshold" | "budget" | "entry_count" | null }> =>
    Effect.gen(function* () {
      if (budgetTracker) {
        const byBudget = yield* budgetTracker.shouldCompact();
        const entries = yield* budgetTracker.getEntryCount();

        if (byBudget) {
          return { shouldCompact: true, triggeredBy: "budget" };
        }

        if (entries >= config.maxEntriesBeforeCompaction) {
          return { shouldCompact: true, triggeredBy: "entry_count" };
        }

        return { shouldCompact: false, triggeredBy: null };
      }

      const byThreshold = shouldCompactByThreshold(tokens, entryCount);
      return {
        shouldCompact: byThreshold,
        triggeredBy: byThreshold ? "threshold" : null,
      };
    });

  return {
    trigger,
    thresholdTokens: config.thresholdTokens,
    maxEntriesBeforeCompaction: config.maxEntriesBeforeCompaction,
    budgetAware: config.budgetAware ?? true,
  };
};

export const runCompaction = (
  history: {
    getTotalTokens(): Effect.Effect<number>;
    buildContext(): Effect.Effect<Message[]>;
    getActivePath(): Effect.Effect<Array<{ id: string; type: string }>>;
    appendCompaction(input: { summary: string; firstKeptEntryId: string; tokensBefore: number }): Effect.Effect<string>;
  },
  options: {
    readonly modelId: string;
    readonly provider: {
      readonly chat: (messages: Message[]) => Effect.Effect<{ content: string; usage: { totalTokens: number } }>;
    };
    readonly systemPrompt?: string;
    readonly triggeredBy?: CompactionResult["triggeredBy"];
  }
): Effect.Effect<CompactionResult, CompactionError> =>
  Effect.gen(function* () {
    const tokensBefore = yield* history.getTotalTokens();

    const contextMessages = yield* history.buildContext();

    if (contextMessages.length === 0) {
      return yield* Effect.fail(new CompactionError("No messages to compact"));
    }

    const summaryPrompt = buildSummaryPrompt(contextMessages, tokensBefore);

    const summaryMessages: Message[] = [
      {
        id: crypto.randomUUID(),
        role: "system",
        content: "You are a context summarizer. Create a concise summary preserving key facts, decisions, and context. Format as: [Summary] <concise summary>",
        timestamp: Date.now(),
      },
      {
        id: crypto.randomUUID(),
        role: "user",
        content: summaryPrompt,
        timestamp: Date.now(),
      },
    ];

    const summaryResponse = yield* options.provider.chat(summaryMessages);

    const summary = extractSummary(summaryResponse.content);

    const path = yield* history.getActivePath();
    const lastEntry = path[path.length - 1];

    if (!lastEntry) {
      return yield* Effect.fail(new CompactionError("Empty history path"));
    }

    yield* history.appendCompaction({
      summary,
      firstKeptEntryId: lastEntry.id,
      tokensBefore,
    });

    const tokensAfter = yield* history.getTotalTokens();

    return {
      compacted: true,
      tokensBefore,
      tokensAfter,
      summary,
      triggeredBy: options.triggeredBy ?? "threshold",
    };
  });

function buildSummaryPrompt(messages: Message[], tokensBefore: number): string {
  const messageTexts = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  return `Summarize the conversation preserving all key context, decisions, and important details:\n\n${messageTexts}\n\nProvide a concise summary that captures the essential information:`;
}

function extractSummary(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("[Summary]")) {
    return trimmed;
  }
  return `[Summary]\n\n${trimmed}`;
}

export const withCompaction = <A, E>(
  effect: Effect.Effect<A, E>,
  history: {
    getTotalTokens(): Effect.Effect<number>;
    addTokens?(tokens: number): Effect.Effect<void>;
  },
  triggerCheck: Effect.Effect<boolean>,
  compaction: Effect.Effect<CompactionResult, CompactionError>
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const result = yield* effect;

    if (history.addTokens) {
      const tokens = yield* history.getTotalTokens();
      yield* history.addTokens(tokens);
    }

    const shouldCompact = yield* triggerCheck;

    if (shouldCompact) {
      yield* Effect.forkChild(
        compaction.pipe(
          Effect.catch_((e) =>
            Effect.sync(() => console.error("[compaction] failed:", e.message))
          )
        )
      );
    }

    return result;
  });