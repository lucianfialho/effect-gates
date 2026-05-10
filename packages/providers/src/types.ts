import { Effect } from "effect";

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolResult {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError?: boolean;
}

export interface Message {
  readonly role: "user" | "assistant" | "system" | "context";
  readonly content: string;
  readonly timestamp: number;
  readonly toolCalls?: ToolCall[];
  readonly toolResults?: ToolResult[];
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
  readonly reasoningDetails?: string;
}

export interface ProviderError {
  readonly code: string;
  readonly message: string;
}

export type ProviderStreamEvent =
  | { type: "tool_call";   id: string; name: string; args: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "delta";       text: string };

export interface Provider {
  readonly id: string;
  readonly chat: (
    messages: Message[],
    tools?: Tool[],
    /** Optional streaming callback — emits events as they arrive (tool calls, text deltas). */
    onEvent?: (event: ProviderStreamEvent) => void
  ) => Effect.Effect<ChatResponse, ProviderError>;
}

export interface StreamingChunk {
  readonly content: string;
  readonly toolCalls?: ToolCall[];
  readonly done: boolean;
}
