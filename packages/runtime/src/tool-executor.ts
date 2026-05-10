import { Effect } from "effect";
import type { Tool } from "./tools.js";
import type { ToolCall, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

export type { ToolCall, ToolResult };

export interface ToolExecutor {
  readonly tools: Map<string, Tool>;
  readonly execute: (call: ToolCall) => Effect.Effect<ToolResult>;
  readonly executeAll: (calls: ToolCall[]) => Effect.Effect<ToolResult[]>;
}

export const makeToolExecutor = (tools: Tool[]): Effect.Effect<ToolExecutor> =>
  Effect.gen(function* () {
    const toolsMap = new Map(tools.map((t) => [t.name, t]));

    const execute = (call: ToolCall): Effect.Effect<ToolResult> =>
      Effect.gen(function* () {
        const tool = toolsMap.get(call.name);

        if (!tool) {
          return toolError(`Tool "${call.name}" not found`);
        }

        const result = yield* Effect.result(tool.execute(call.params));

        if (result._tag === "Failure") {
          return toolError(String(result.failure));
        }

        return result.success;
      });

    const executeAll = (calls: ToolCall[]): Effect.Effect<ToolResult[]> =>
      Effect.all(calls.map((call) => execute(call)));

    return { tools: toolsMap, execute, executeAll };
  });