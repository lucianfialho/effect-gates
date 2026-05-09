import { Effect } from "effect";
import type { Tool } from "./tools.js";
import type { ToolCall, ToolResult } from "./tools.js";

export type { ToolCall, ToolResult };

export interface ToolExecutor {
  readonly tools: Map<string, Tool>;
  readonly execute: (call: ToolCall) => Effect.Effect<ToolResult>;
  readonly executeAll: (calls: ToolCall[]) => Effect.Effect<ToolResult[]>;
}

const toolError = (message: string): ToolResult => ({
  content: `Error: ${message}`,
  isError: true,
});

export const makeToolExecutor = (tools: Tool[]): Effect.Effect<ToolExecutor> =>
  Effect.gen(function* () {
    const toolsMap = new Map(tools.map((t) => [t.name, t]));

    const execute = (call: ToolCall): Effect.Effect<ToolResult> =>
      Effect.gen(function* () {
        const tool = toolsMap.get(call.name);

        if (!tool) {
          return toolError(`Tool "${call.name}" not found`);
        }

        const result = yield* Effect.either(tool.execute(call.params));

        if (result._tag === "Left") {
          return toolError(String(result.left));
        }

        return result.right;
      });

    const executeAll = (calls: ToolCall[]): Effect.Effect<ToolResult[]> =>
      Effect.all(calls.map((call) => execute(call)));

    return { tools: toolsMap, execute, executeAll };
  });

export const toolResult = (content: string, metadata?: Record<string, unknown>): ToolResult => ({
  content,
  metadata,
});