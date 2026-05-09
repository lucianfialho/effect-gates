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

export interface Provider {
  readonly id: string;
  readonly chat: (messages: Message[], tools?: Tool[]) => Effect.Effect<ChatResponse, ProviderError>;
}

export interface StreamingChunk {
  readonly content: string;
  readonly toolCalls?: ToolCall[];
  readonly done: boolean;
}
