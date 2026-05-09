import { Effect } from "effect";
import { Message, ChatResponse, Provider, ProviderError } from "../types.js";

export interface AnthropicConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text: string;
  }>;
  model: string;
  stop_reason: string;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export const makeAnthropicProvider = (config: AnthropicConfig): Provider => {
  const model = config.model ?? "claude-3-5-sonnet-20241022";
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com/v1";

  return {
    id: "anthropic",
    chat: (messages: Message[]): Effect.Effect<ChatResponse, ProviderError> =>
      Effect.tryPromise({
        try: async () => {
          const systemMessage = messages.find((m) => m.role === "system");
          const conversationMessages = messages.filter((m) => m.role !== "system");

          const body: Record<string, unknown> = {
            model,
            messages: conversationMessages.map((m) => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: m.content,
            })),
            max_tokens: 4096,
            temperature: 0.7,
          };

          if (systemMessage) {
            body.system = systemMessage.content;
          }

          const response = await fetch(`${baseUrl}/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": config.apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            const error = await response.text();
            throw new Error(`Anthropic API error: ${response.status} - ${error}`);
          }

          const data = (await response.json()) as AnthropicResponse;
          const textContent = data.content.find((c) => c.type === "text");

          if (!textContent) {
            throw new Error("No text content from Anthropic");
          }

          const inputCost = data.usage.input_tokens * 0.000003;
          const outputCost = data.usage.output_tokens * 0.000015;

          return {
            content: textContent.text,
            usage: {
              inputTokens: data.usage.input_tokens,
              outputTokens: data.usage.output_tokens,
              totalTokens: data.usage.input_tokens + data.usage.output_tokens,
            },
            cost: inputCost + outputCost,
          } satisfies ChatResponse;
        },
        catch: (error) => ({
          code: "ANTHROPIC_ERROR",
          message: error instanceof Error ? error.message : String(error),
        } satisfies ProviderError),
      }),
  };
};
