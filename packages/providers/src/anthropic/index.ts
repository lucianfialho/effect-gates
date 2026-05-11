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
  /**
   * Override the OAuth identity headers sent when using sk-ant-oat* tokens.
   * Defaults to Claude Code CLI headers required by Anthropic's OAuth flow.
   * Set to false to disable identity injection entirely.
   */
  readonly oauthIdentity?: { appId: string; betaFlags: string } | false;
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
    chat: (messages: Message[], tools?: Tool[], onEvent?: (e: import("../types.js").ProviderStreamEvent) => void): Effect.Effect<ChatResponse, ProviderError> =>
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

          const isOAuthToken = config.apiKey.startsWith("sk-ant-oat");

          if (isOAuthToken && config.oauthIdentity !== false) {
            const identity = config.oauthIdentity ?? {
              appId: "cli",
              betaFlags: "claude-code-20250219,oauth-2025-04-20",
            };
            const identityBlock = {
              type: "text",
              text: `You are an AI assistant using the ${identity.appId} interface.`,
            };
            if (body.system) {
              body.system = [identityBlock, { type: "text", text: body.system }];
            } else {
              body.system = [identityBlock];
            }
          }

          const authHeaders: Record<string, string> = isOAuthToken
            ? (() => {
                const identity = config.oauthIdentity !== false
                  ? (config.oauthIdentity ?? { appId: "cli", betaFlags: "claude-code-20250219,oauth-2025-04-20" })
                  : null;
                return {
                  "Authorization": `Bearer ${config.apiKey}`,
                  ...(identity ? {
                    "anthropic-beta": identity.betaFlags,
                    "x-app": identity.appId,
                  } : {}),
                };
              })()
            : { "x-api-key": config.apiKey };

          const headers = {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            ...authHeaders,
          };

          // ── Streaming mode when onEvent is provided ───────────────────────
          if (onEvent) {
            body.stream = true;
            const response = await fetch(`${baseUrl}/messages`, {
              method: "POST", headers, body: JSON.stringify(body),
            });
            if (!response.ok) {
              const error = await response.text();
              const retryAfter = response.headers.get("retry-after");
              throw new Error(`Anthropic API error: ${response.status}${retryAfter ? ` (retry-after: ${retryAfter}s)` : ""} - ${error}`);
            }

            // Parse SSE stream line by line
            const reader = response.body!.getReader();
            const dec = new TextDecoder();
            let buf = "";
            const toolBufs = new Map<number, { id: string; name: string; json: string }>();
            const completedToolCalls: ToolCall[] = [];
            let textContent = "";
            let thinkingContent = "";
            let finalUsage = { input_tokens: 0, output_tokens: 0 };
            let stopReason = "end_turn";

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              const lines = buf.split("\n");
              buf = lines.pop() ?? "";

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const raw = line.slice(6).trim();
                if (raw === "[DONE]") continue;
                let ev: Record<string, unknown>;
                try { ev = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }

                const t = ev.type as string;

                if (t === "content_block_start") {
                  const idx = ev.index as number;
                  const cb = ev.content_block as Record<string, unknown>;
                  if (cb.type === "tool_use") {
                    toolBufs.set(idx, { id: cb.id as string, name: cb.name as string, json: "" });
                  }
                }

                if (t === "content_block_delta") {
                  const idx = ev.index as number;
                  const delta = ev.delta as Record<string, unknown>;
                  if (delta.type === "text_delta" && delta.text) {
                    textContent += delta.text as string;
                    onEvent({ type: "delta", text: delta.text as string });
                  }
                  if (delta.type === "thinking_delta" && delta.thinking) {
                    thinkingContent += delta.thinking as string;
                    onEvent({ type: "delta", text: delta.thinking as string });
                  }
                  if (delta.type === "input_json_delta") {
                    const buf2 = toolBufs.get(idx);
                    if (buf2) buf2.json += (delta.partial_json as string) ?? "";
                  }
                }

                if (t === "content_block_stop") {
                  const idx = ev.index as number;
                  const buf2 = toolBufs.get(idx);
                  if (buf2) {
                    // Emit for UI streaming AND accumulate for agent loop execution
                    onEvent({ type: "tool_call", id: buf2.id, name: buf2.name, args: buf2.json });
                    completedToolCalls.push({ id: buf2.id, name: buf2.name, arguments: buf2.json });
                    toolBufs.delete(idx);
                  }
                }

                if (t === "message_delta") {
                  const d = ev.delta as Record<string, unknown>;
                  stopReason = (d.stop_reason as string) ?? stopReason;
                  const u = ev.usage as Record<string, number> | undefined;
                  if (u) finalUsage.output_tokens = u.output_tokens ?? 0;
                }

                if (t === "message_start") {
                  const msg = ev.message as Record<string, unknown>;
                  const u = msg.usage as Record<string, number> | undefined;
                  if (u) finalUsage.input_tokens = u.input_tokens ?? 0;
                }
              }
            }

            const modelId = model;
            const ANTHROPIC_PRICES: Record<string, { input: number; output: number }> = {
              "claude-haiku-4-5":  { input: 0.0000008,  output: 0.000004  },
              "claude-sonnet-4-6": { input: 0.000003,   output: 0.000015  },
            };
            const prices = ANTHROPIC_PRICES[Object.keys(ANTHROPIC_PRICES).find(k => model.startsWith(k)) ?? ""]
              ?? { input: 0.000003, output: 0.000015 };

            return {
              content: textContent,
              // Return accumulated tool calls so runAgentLoop can execute them
              toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
              usage: {
                inputTokens: finalUsage.input_tokens,
                outputTokens: finalUsage.output_tokens,
                totalTokens: finalUsage.input_tokens + finalUsage.output_tokens,
              },
              cost: finalUsage.input_tokens * prices.input + finalUsage.output_tokens * prices.output,
              ...(thinkingContent ? { reasoningDetails: thinkingContent } : {}),
            } satisfies ChatResponse;
          }

          // ── Non-streaming (original path) ─────────────────────────────────
          const response = await fetch(`${baseUrl}/messages`, {
            method: "POST", headers, body: JSON.stringify(body),
          });

          if (!response.ok) {
            const error = await response.text();
            const retryAfter = response.headers.get("retry-after") ?? response.headers.get("x-ratelimit-reset-requests");
            const hint = retryAfter ? ` (retry-after: ${retryAfter}s)` : "";
            throw new Error(`Anthropic API error: ${response.status}${hint} - ${error}`);
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

          // Per-model pricing ($/token). Source: https://www.anthropic.com/pricing
          const ANTHROPIC_PRICES: Record<string, { input: number; output: number }> = {
            "claude-opus-4-7":    { input: 0.000015,   output: 0.000075  },
            "claude-sonnet-4-6":  { input: 0.000003,   output: 0.000015  },
            "claude-haiku-4-5":   { input: 0.0000008,  output: 0.000004  },
            "claude-3-5-sonnet":  { input: 0.000003,   output: 0.000015  },
            "claude-3-opus":      { input: 0.000015,   output: 0.000075  },
            "claude-3-haiku":     { input: 0.00000025, output: 0.00000125 },
          };
          const modelId = data.model ?? model;
          const prices = ANTHROPIC_PRICES[modelId]
            ?? ANTHROPIC_PRICES[Object.keys(ANTHROPIC_PRICES).find((k) => modelId.startsWith(k)) ?? ""]
            ?? { input: 0.000003, output: 0.000015 };
          const inputCost = data.usage.input_tokens * prices.input;
          const outputCost = data.usage.output_tokens * prices.output;

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
