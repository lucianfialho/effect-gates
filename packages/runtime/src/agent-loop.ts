import { Effect } from "effect";
import type { Message } from "./session-history.js";
import type { Tool, ToolCall, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

// ── Events ────────────────────────────────────────────────────────────────────

export type AgentLoopEvent =
  | { type: "tool_call";   id: string; name: string; args: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "compaction";  tokensBefore: number; tokensAfter: number; messagesBefore: number; messagesAfter: number };

// ── Compaction ─────────────────────────────────────────────────────────────────

/**
 * In-loop compaction config.
 *
 * When the accumulated messages (system + history + tool results) exceed
 * `thresholdTokens`, the loop summarizes older messages before the next
 * LLM call — keeping token usage bounded across many tool call iterations.
 *
 * Effect design:
 * - `summarize` returns `Effect<string, unknown>` — errors are always caught
 *   via `Effect.result` so a failed summary never crashes the loop.
 * - Graceful degradation: if summarization fails, older messages are
 *   hard-truncated (500 chars each) rather than left unbounded.
 */
export interface LoopCompactionConfig {
  /** Trigger compaction when estimated context tokens exceed this. Default: 30_000 */
  readonly thresholdTokens?: number;
  /** How many recent messages to keep verbatim after compaction. Default: 8 */
  readonly keepRecentMessages?: number;
  /**
   * LLM call used for summarization.
   * Injected by the harness — uses the same provider as the main loop.
   * Error type is `unknown` because we always degrade gracefully on failure.
   */
  readonly summarize: (messages: Message[]) => Effect.Effect<string, unknown>;
}

// ── Token estimation ──────────────────────────────────────────────────────────

const estimateTokens = (messages: Message[]): number =>
  messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 4, 0);

// ── Compact message array ─────────────────────────────────────────────────────

const compactMessages = (
  messages: Message[],
  cfg: Required<LoopCompactionConfig>,
  onEvent?: (e: AgentLoopEvent) => void
): Effect.Effect<Message[]> =>
  Effect.gen(function* () {
    const tokensBefore = estimateTokens(messages);
    if (tokensBefore <= cfg.thresholdTokens) return messages;

    const systemMsgs = messages.filter((m) => m.role === "system");
    const nonSystem  = messages.filter((m) => m.role !== "system");

    // Not enough history to make compaction worthwhile
    if (nonSystem.length <= cfg.keepRecentMessages + 2) return messages;

    const toSummarize = nonSystem.slice(0, nonSystem.length - cfg.keepRecentMessages);
    const recent      = nonSystem.slice(-cfg.keepRecentMessages);

    // Build input for the summarizer — cap each message to avoid recursive overload
    const summaryInput = toSummarize
      .map((m) => {
        const capped = m.content.length > 400 ? m.content.slice(0, 400) + "…" : m.content;
        return `[${m.role}]: ${capped}`;
      })
      .join("\n\n");

    const summaryMessages: Message[] = [
      {
        id: crypto.randomUUID(),
        role: "system",
        content: "Summarize this agent investigation context. Preserve: files explored, key findings, patterns identified, decisions made. Be concise.",
        timestamp: Date.now(),
      },
      {
        id: crypto.randomUUID(),
        role: "user",
        content: summaryInput,
        timestamp: Date.now(),
      },
    ];

    // Effect.result: summarization failure becomes a value, never propagates
    const summaryResult = yield* Effect.result(cfg.summarize(summaryMessages));

    let compacted: Message[];

    if (summaryResult._tag === "Success") {
      const summaryMsg: Message = {
        id: crypto.randomUUID(),
        role: "context",
        content: `[Context Summary — ${toSummarize.length} messages compacted]\n\n${summaryResult.success}`,
        timestamp: Date.now(),
      };
      compacted = [...systemMsgs, summaryMsg, ...recent];
    } else {
      // Graceful degradation: hard-cap each old message instead of losing them
      const truncated = toSummarize.map((m) => ({
        ...m,
        content: m.content.length > 500 ? m.content.slice(0, 500) + " …[truncated]" : m.content,
      }));
      compacted = [...systemMsgs, ...truncated, ...recent];
    }

    const tokensAfter = estimateTokens(compacted);
    onEvent?.({
      type: "compaction",
      tokensBefore,
      tokensAfter,
      messagesBefore: messages.length,
      messagesAfter: compacted.length,
    });

    return compacted;
  });

// ── Config ─────────────────────────────────────────────────────────────────────

export interface AgentLoopConfig {
  readonly maxIterations: number;
  readonly timeoutMs?: number;
  readonly toolConcurrency?: "sequential" | "unbounded" | number;
  readonly onEvent?: (event: AgentLoopEvent) => void;
  /**
   * In-loop context compaction.
   * When omitted, context grows unbounded (old behaviour).
   * When provided, the loop compacts messages before each LLM call
   * if the estimated token count exceeds the threshold.
   */
  readonly compaction?: LoopCompactionConfig;
}

export interface AgentLoopState {
  readonly iteration: number;
  readonly messages: Message[];
  readonly toolCalls: ToolCall[];
  readonly toolResults: ToolResult[];
}

export interface AgentLoopResult {
  readonly finalContent: string;
  readonly totalIterations: number;
  readonly allToolCalls: ToolCall[];
  readonly allToolResults: ToolResult[];
  readonly didComplete: boolean;
}

const DEFAULT_CONFIG: AgentLoopConfig = {
  maxIterations: 10,
};

export interface ProviderResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

type LLMCall = (messages: Message[]) => Effect.Effect<ProviderResponse, Error>;

interface ToolResultWithId {
  readonly toolCallId: string;
  readonly result: ToolResult;
}

const executeTools = (
  tools: Map<string, Tool>,
  calls: ToolCall[],
  concurrency: AgentLoopConfig["toolConcurrency"]
): Effect.Effect<ToolResultWithId[]> => {
  const effects = calls.map((call) => {
    const tool = tools.get(call.name);
    if (!tool) {
      return Effect.succeed({
        toolCallId: call.id,
        result: toolError(`Tool "${call.name}" not found`),
      });
    }
    return Effect.gen(function* () {
      const execResult = yield* tool.execute(call.params);
      return { toolCallId: call.id, result: execResult };
    });
  });

  if (!concurrency || concurrency === "sequential") {
    return Effect.all(effects);
  }
  return Effect.all(effects, {
    concurrency: concurrency === "unbounded" ? "unbounded" : concurrency,
  });
};

// ── runAgentLoop ───────────────────────────────────────────────────────────────

export const runAgentLoop = (
  llmCall: LLMCall,
  tools: Map<string, Tool>,
  initialMessages: Message[],
  config: AgentLoopConfig = DEFAULT_CONFIG,
): Effect.Effect<AgentLoopResult, Error> =>
  Effect.gen(function* () {
    let iteration    = 0;
    let messages     = initialMessages;
    const allToolCalls:   ToolCall[]   = [];
    const allToolResults: ToolResult[] = [];
    let finalContent = "";
    let didComplete  = false;

    const compactionCfg: Required<LoopCompactionConfig> | null = config.compaction
      ? {
          thresholdTokens:    config.compaction.thresholdTokens    ?? 30_000,
          keepRecentMessages: config.compaction.keepRecentMessages ?? 8,
          summarize:          config.compaction.summarize,
        }
      : null;

    while (iteration < config.maxIterations) {
      // ── Compact context before calling LLM ───────────────────────────────
      if (compactionCfg) {
        messages = yield* compactMessages(messages, compactionCfg, config.onEvent);
      }

      const response = yield* llmCall(messages);
      finalContent = response.content;

      if (!response.toolCalls || response.toolCalls.length === 0) {
        didComplete = true;
        break;
      }

      // Emit tool_call events before executing
      for (const call of response.toolCalls) {
        config.onEvent?.({ type: "tool_call", id: call.id, name: call.name, args: JSON.stringify(call.params) });
      }

      const toolResultsWithIds = yield* executeTools(tools, response.toolCalls, config.toolConcurrency);

      // Emit tool_result events after executing
      for (let i = 0; i < response.toolCalls.length; i++) {
        const call = response.toolCalls[i]!;
        const res  = toolResultsWithIds[i]!.result;
        config.onEvent?.({ type: "tool_result", id: call.id, name: call.name, output: res.content, isError: res.isError ?? false });
      }

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response.content,
        timestamp: Date.now(),
      };

      const toolMessages: Message[] = toolResultsWithIds.map((r, i): Message => ({
        id: crypto.randomUUID(),
        role: "tool",
        content: JSON.stringify({
          tool_call_id: response.toolCalls![i]!.id,
          content: r.result.content,
          is_error: r.result.isError ?? false,
        }),
        timestamp: Date.now(),
      }));

      messages = [...messages, assistantMessage, ...toolMessages];
      allToolCalls.push(...response.toolCalls);
      allToolResults.push(...toolResultsWithIds.map((r) => r.result));
      iteration++;
    }

    return {
      finalContent,
      totalIterations: iteration,
      allToolCalls,
      allToolResults,
      didComplete,
    };
  });
