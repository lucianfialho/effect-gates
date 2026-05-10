import { Effect } from "effect";
import { Message, ChatResponse, Provider, ProviderError, Tool, ToolCall } from "../types.js";

export interface MiniMaxConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

interface MiniMaxMessage {
  role: string;
  content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string }; index: number }>;
}

interface MiniMaxFunctionCall {
  name: string;
  arguments: string;
}

interface MiniMaxToolCall {
  id: string;
  type: string;
  function: MiniMaxFunctionCall;
  index: number;
}

interface MiniMaxResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      name?: string;
      tool_calls?: MiniMaxToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  reasoning_details?: Array<{
    type: string;
    id: string;
    text: string;
  }>;
}

export const makeMiniMaxProvider = (config: MiniMaxConfig): Provider => {
  const model = config.model ?? "MiniMax-M2.7";
  const baseUrl = config.baseUrl ?? "https://api.minimax.io/v1";

  return {
    id: "minimax",
    chat: (messages: Message[], tools?: Tool[]): Effect.Effect<ChatResponse, ProviderError> =>
      Effect.tryPromise({
        try: async () => {
          const body: Record<string, unknown> = {
            model,
            messages: messages.flatMap((m): MiniMaxMessage[] => {
              // context role → system
              if (m.role === "context") {
                return [{ role: "system", content: m.content }];
              }
              // tool result messages
              if (m.toolResults && m.toolResults.length > 0) {
                return m.toolResults.map((tr) => ({
                  role: "tool",
                  content: tr.content,
                  tool_call_id: tr.toolCallId,
                } as MiniMaxMessage));
              }
              // assistant message with tool calls
              if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
                return [{
                  role: "assistant",
                  content: m.content || "",
                  tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: tc.arguments },
                    index: 0,
                  })),
                } as MiniMaxMessage];
              }
              return [{ role: m.role, content: m.content }];
            }),
            temperature: 0.7,
            max_tokens: 4096,
          };

          if (tools && tools.length > 0) {
            body.tools = tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            }));
            body.extra_body = { reasoning_split: true };
          }

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
            throw new Error(`MiniMax API error: ${response.status} - ${error}`);
          }

          const data = (await response.json()) as MiniMaxResponse;
          const choice = data.choices[0];

          if (!choice) {
            throw new Error("No response from MiniMax");
          }

          // MiniMax pricing (per token): https://www.minimaxi.com/en/price
          const MINIMAX_PRICES: Record<string, { input: number; output: number }> = {
            "MiniMax-M2.7": { input: 0.0000003, output: 0.0000011 },
          };
          const prices = MINIMAX_PRICES[data.model] ?? MINIMAX_PRICES["MiniMax-M2.7"]!;
          const inputCost = data.usage.prompt_tokens * prices.input;
          const outputCost = data.usage.completion_tokens * prices.output;

          const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }));

          const reasoningDetails = data.reasoning_details
            ?.map((r) => r.text)
            .join("\n");

          return {
            content: choice.message.content || "",
            toolCalls,
            usage: {
              inputTokens: data.usage.prompt_tokens,
              outputTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            },
            cost: inputCost + outputCost,
            reasoningDetails,
          } satisfies ChatResponse;
        },
        catch: (error: unknown) => ({
          code: "MINIMAX_ERROR",
          message: error instanceof Error ? error.message : String(error),
        } satisfies ProviderError),
      }),
  };
};