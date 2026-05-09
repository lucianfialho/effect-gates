import { Effect } from "effect";
import { Message, ChatResponse, Provider, ProviderError, Tool, ToolCall } from "../types.js";

export interface AnthropicThinking {
  /** Enable extended thinking. Requires model claude-3-7-sonnet or later. */
  readonly enabled: boolean;
  /** Token budget for thinking (default: 10000). Must be < max_tokens. */
  readonly budgetTokens?: number;
}

export interface AnthropicConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly thinking?: AnthropicThinking;
}

// ── Anthropic API types ─────────────────────────────────────────────────────

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicApiMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | string;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

// ── Message conversion ──────────────────────────────────────────────────────

const toAnthropicMessage = (msg: Message): AnthropicApiMessage | null => {
  if (msg.role === "system" || msg.role === "context") return null;

  // User message carrying tool results — converted to tool_result blocks
  if (msg.toolResults && msg.toolResults.length > 0) {
    const blocks: AnthropicContentBlock[] = msg.toolResults.map((tr) => ({
      type: "tool_result" as const,
      tool_use_id: tr.toolCallId,
      content: tr.content,
      ...(tr.isError ? { is_error: true } : {}),
    }));
    if (msg.content) blocks.unshift({ type: "text", text: msg.content });
    return { role: "user", content: blocks };
  }

  // Assistant message with tool calls — converted to tool_use blocks
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
    const blocks: AnthropicContentBlock[] = [];
    if (msg.content) blocks.push({ type: "text", text: msg.content });
    for (const tc of msg.toolCalls) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.arguments); } catch { input = { args: tc.arguments }; }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }
    return { role: "assistant", content: blocks };
  }

  return {
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content,
  };
};

const toAnthropicTool = (tool: Tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
});

// ── Provider ────────────────────────────────────────────────────────────────

export const makeAnthropicProvider = (config: AnthropicConfig): Provider => {
  const model = config.model ?? "claude-sonnet-4-6";
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com/v1";

  return {
    id: "anthropic",
    chat: (messages: Message[], tools?: Tool[]): Effect.Effect<ChatResponse, ProviderError> =>
      Effect.tryPromise({
        try: async () => {
          const systemMessage = messages.find((m) => m.role === "system" || m.role === "context");
          const conversationMessages = messages
            .filter((m) => m.role !== "system" && m.role !== "context")
            .map(toAnthropicMessage)
            .filter((m): m is AnthropicApiMessage => m !== null);

          const thinkingEnabled = config.thinking?.enabled;
          const budgetTokens = config.thinking?.budgetTokens ?? 10000;
          // Thinking requires max_tokens > budget_tokens
          const maxTokens = thinkingEnabled ? Math.max(16000, budgetTokens + 1000) : 4096;

          const body: Record<string, unknown> = {
            model,
            messages: conversationMessages,
            max_tokens: maxTokens,
          };

          if (thinkingEnabled) {
            body.thinking = { type: "enabled", budget_tokens: budgetTokens };
          }

          if (systemMessage) {
            body.system = systemMessage.content;
          }

          if (tools && tools.length > 0) {
            body.tools = tools.map(toAnthropicTool);
            body.tool_choice = { type: "auto" };
          }

          // OAuth tokens (oat01) use Bearer auth; standard API keys use x-api-key
          const isOAuthToken = config.apiKey.startsWith("sk-ant-oat");
          const authHeaders: Record<string, string> = isOAuthToken
            ? { "Authorization": `Bearer ${config.apiKey}` }
            : { "x-api-key": config.apiKey };

          const response = await fetch(`${baseUrl}/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "anthropic-version": "2023-06-01",
              ...authHeaders,
            },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            const error = await response.text();
            throw new Error(`Anthropic API error: ${response.status} - ${error}`);
          }

          const data = (await response.json()) as AnthropicResponse;

          const thinkingContent = data.content
            .filter((c) => c.type === "thinking")
            .map((c) => (c as { type: "thinking"; thinking: string }).thinking)
            .join("\n");

          const textContent = data.content
            .filter((c) => c.type === "text")
            .map((c) => (c as { type: "text"; text: string }).text)
            .join("\n");

          const toolUseBlocks = data.content.filter((c) => c.type === "tool_use") as Array<{
            type: "tool_use"; id: string; name: string; input: Record<string, unknown>;
          }>;

          const toolCalls: ToolCall[] | undefined =
            toolUseBlocks.length > 0
              ? toolUseBlocks.map((block) => ({
                  id: block.id,
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                }))
              : undefined;

          const inputCost = data.usage.input_tokens * 0.000003;
          const outputCost = data.usage.output_tokens * 0.000015;

          return {
            content: textContent,
            toolCalls,
            usage: {
              inputTokens: data.usage.input_tokens,
              outputTokens: data.usage.output_tokens,
              totalTokens: data.usage.input_tokens + data.usage.output_tokens,
            },
            cost: inputCost + outputCost,
            ...(thinkingContent ? { reasoningDetails: thinkingContent } : {}),
          } satisfies ChatResponse;
        },
        catch: (error: unknown) => ({
          code: "ANTHROPIC_ERROR",
          message: error instanceof Error ? error.message : String(error),
        } satisfies ProviderError),
      }),
  };
};
