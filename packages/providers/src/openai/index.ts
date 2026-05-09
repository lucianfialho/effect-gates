import { Effect } from "effect";
import { Message, ChatResponse, Provider, ProviderError } from "../types.js";

export interface OpenAIConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

interface OpenAIMessage {
  role: string;
  content: string;
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export const makeOpenAIProvider = (config: OpenAIConfig): Provider => {
  const model = config.model ?? "gpt-4o";
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";

  return {
    id: "openai",
    chat: (messages: Message[]): Effect.Effect<ChatResponse, ProviderError> =>
      Effect.tryPromise({
        try: async () => {
          const body = {
            model,
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })) as OpenAIMessage[],
            temperature: 0.7,
            max_tokens: 4096,
          };

          const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} - ${error}`);
          }

          const data = (await response.json()) as OpenAIResponse;
          const choice = data.choices[0];

          if (!choice) {
            throw new Error("No response from OpenAI");
          }

          const inputCost = data.usage.prompt_tokens * 0.000003;
          const outputCost = data.usage.completion_tokens * 0.000015;

          return {
            content: choice.message.content,
            usage: {
              inputTokens: data.usage.prompt_tokens,
              outputTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            },
            cost: inputCost + outputCost,
          } satisfies ChatResponse;
        },
        catch: (error) => ({
          code: "OPENAI_ERROR",
          message: error instanceof Error ? error.message : String(error),
        } satisfies ProviderError),
      }),
  };
};
