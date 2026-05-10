import { Effect } from "effect";
import type { Message } from "./session-history.js";
import type { Tool, ToolCall, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

export type AgentLoopEvent =
  | { type: "tool_call"; id: string; name: string; args: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean };

export interface AgentLoopConfig {
  readonly maxIterations: number;
  readonly timeoutMs?: number;
  readonly toolConcurrency?: "sequential" | "unbounded" | number;
  readonly onEvent?: (event: AgentLoopEvent) => void;
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
      return {
        toolCallId: call.id,
        result: execResult,
      };
    });
  });

  if (!concurrency || concurrency === "sequential") {
    return Effect.all(effects);
  }
  return Effect.all(effects, {
    concurrency: concurrency === "unbounded" ? "unbounded" : concurrency,
  });
};

export const runAgentLoop = (
  llmCall: LLMCall,
  tools: Map<string, Tool>,
  initialMessages: Message[],
  config: AgentLoopConfig = DEFAULT_CONFIG,
): Effect.Effect<AgentLoopResult, Error> =>
  Effect.gen(function* () {
    let iteration = 0;
    let messages = initialMessages;
    const allToolCalls: ToolCall[] = [];
    const allToolResults: ToolResult[] = [];
    let finalContent = "";
    let didComplete = false;

    while (iteration < config.maxIterations) {
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
      const toolResults = toolResultsWithIds.map((r) => r.result);

      // Emit tool_result events after executing
      for (let i = 0; i < response.toolCalls.length; i++) {
        const call = response.toolCalls[i];
        const res = toolResultsWithIds[i].result;
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
          tool_call_id: response.toolCalls![i].id,
          content: r.result.content,
          is_error: r.result.isError ?? false,
        }),
        timestamp: Date.now(),
      }));

      messages = [...messages, assistantMessage, ...toolMessages];
      allToolCalls.push(...response.toolCalls);
      allToolResults.push(...toolResults);
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