import { Effect } from "effect";

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface ToolCall {
  readonly name: string;
  readonly params: Record<string, unknown>;
  readonly id: string;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly execute: (params: Record<string, unknown>) => Effect.Effect<ToolResult>;
}

export interface ChatResponse {
  readonly content: string;
  readonly toolCalls?: ToolCall[];
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly cost?: number;
}

export const toolResult = (content: string, metadata?: Record<string, unknown>): ToolResult => ({
  content,
  metadata,
});

export const toolError = (message: string): ToolResult => ({
  content: `Error: ${message}`,
  isError: true,
});

export const makeToolCall = (name: string, params: Record<string, unknown>, id?: string): ToolCall => ({
  name,
  params,
  id: id ?? crypto.randomUUID(),
});