import { Effect } from "effect";
import type { Message } from "./session-history.js";
import type { Tool, ToolCall, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

export interface AgentLoopConfig {
  readonly maxIterations: number;
  readonly timeoutMs?: number;
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
  calls: ToolCall[]
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
  return Effect.all(effects);
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

      const toolResultsWithIds = yield* executeTools(tools, response.toolCalls);
      const toolResults = toolResultsWithIds.map((r) => r.result);

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