import { Effect } from "effect";
import { Message, ChatResponse, Provider, ProviderError, Tool, ToolCall } from "../types.js";

export interface OpenAIConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /**
   * Reasoning effort for o1/o3 models.
   * @see https://platform.openai.com/docs/guides/reasoning
   */
  readonly reasoningEffort?: "low" | "medium" | "high";
}

// ── OpenAI API types ────────────────────────────────────────────────────────

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
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
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ── Message conversion ──────────────────────────────────────────────────────

// Returns one or more OpenAI messages — tool results expand into separate "tool" role messages
const toOpenAIMessages = (msg: Message): OpenAIMessage | OpenAIMessage[] => {
  if (msg.role === "context") return { role: "system", content: msg.content };

  // Tool results → one "tool" message per result (OpenAI requires separate messages)
  if (msg.toolResults && msg.toolResults.length > 0) {
    return msg.toolResults.map((tr) => ({
      role: "tool",
      tool_call_id: tr.toolCallId,
      content: tr.content,
    }));
  }

  // Assistant message with tool calls
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }

  return { role: msg.role, content: msg.content };
};

const toOpenAITool = (tool: Tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
});

// ── Provider ────────────────────────────────────────────────────────────────

export const makeOpenAIProvider = (config: OpenAIConfig): Provider => {
  const model = config.model ?? "gpt-4o";
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";

  return {
    id: "openai",
    chat: (messages: Message[], tools?: Tool[]): Effect.Effect<ChatResponse, ProviderError> =>
      Effect.tryPromise({
        try: async () => {
          const openAIMessages = messages
            .flatMap((m) => {
              // system/context → system role
              if (m.role === "system") return [{ role: "system", content: m.content }];
              const converted = toOpenAIMessages(m);
              return Array.isArray(converted) ? converted : [converted];
            });

          // o1/o3 models don't support temperature or max_tokens; use reasoning_effort
          const isReasoningModel = model.startsWith("o1") || model.startsWith("o3");
          const body: Record<string, unknown> = {
            model,
            messages: openAIMessages,
            ...(isReasoningModel
              ? { reasoning_effort: config.reasoningEffort ?? "medium" }
              : { temperature: 0.7, max_tokens: 4096 }),
          };

          if (tools && tools.length > 0) {
            body.tools = tools.map(toOpenAITool);
            body.tool_choice = "auto";
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
            throw new Error(`OpenAI API error: ${response.status} - ${error}`);
          }

          const data = (await response.json()) as OpenAIResponse;
          const choice = data.choices[0];

          if (!choice) throw new Error("No response from OpenAI");

          const toolCalls: ToolCall[] | undefined =
            choice.message.tool_calls && choice.message.tool_calls.length > 0
              ? choice.message.tool_calls.map((tc) => ({
                  id: tc.id,
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                }))
              : undefined;

          // Per-model pricing ($/token). Source: https://openai.com/pricing
          const OPENAI_PRICES: Record<string, { input: number; output: number }> = {
            "gpt-4o":       { input: 0.0000025,  output: 0.000010  },
            "gpt-4o-mini":  { input: 0.00000015, output: 0.0000006 },
            "o3":           { input: 0.000010,   output: 0.000040  },
            "o3-mini":      { input: 0.0000011,  output: 0.0000044 },
            "o1":           { input: 0.000015,   output: 0.000060  },
            "gpt-4-turbo":  { input: 0.000010,   output: 0.000030  },
          };
          const prices = OPENAI_PRICES[model] ?? { input: 0.000003, output: 0.000015 };
          const inputCost = data.usage.prompt_tokens * prices.input;
          const outputCost = data.usage.completion_tokens * prices.output;

          return {
            content: choice.message.content ?? "",
            toolCalls,
            usage: {
              inputTokens: data.usage.prompt_tokens,
              outputTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            },
            cost: inputCost + outputCost,
          } satisfies ChatResponse;
        },
        catch: (error: unknown) => ({
          code: "OPENAI_ERROR",
          message: error instanceof Error ? error.message : String(error),
        } satisfies ProviderError),
      }),
  };
};
