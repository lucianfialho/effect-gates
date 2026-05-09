import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { makeOpenAIProvider } from "../openai/index.js";
import type { Message } from "../types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve("") } as Response);

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const provider = makeOpenAIProvider({ apiKey: "test" });

describe("OpenAI provider", () => {
  it("sends tools in function format with tool_choice auto", async () => {
    mockFetch.mockResolvedValueOnce(ok({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage,
    }));

    await Effect.runPromise(
      provider.chat(
        [{ role: "user", content: "hi", timestamp: 0 }],
        [{ name: "bash", description: "Run bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }]
      )
    );

    const body = JSON.parse(mockFetch.mock.lastCall![1].body);
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "bash",
        description: "Run bash",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    });
    expect(body.tool_choice).toBe("auto");
  });

  it("parses tool_calls from response into toolCalls", async () => {
    mockFetch.mockResolvedValueOnce(ok({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage,
    }));

    const result = await Effect.runPromise(provider.chat([{ role: "user", content: "list files", timestamp: 0 }]));

    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({ id: "call_1", name: "bash", arguments: '{"command":"ls"}' });
  });

  it("converts tool results to separate 'tool' role messages", async () => {
    mockFetch.mockResolvedValueOnce(ok({
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage,
    }));

    const messages: Message[] = [
      { role: "user", content: "list files", timestamp: 0 },
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolCalls: [
          { id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
          { id: "call_2", name: "read", arguments: '{"path":"foo.ts"}' },
        ],
      },
      {
        role: "user",
        content: "",
        timestamp: 2,
        toolResults: [
          { toolCallId: "call_1", content: "file.ts" },
          { toolCallId: "call_2", content: "const x = 1" },
        ],
      },
    ];

    await Effect.runPromise(provider.chat(messages));

    const body = JSON.parse(mockFetch.mock.lastCall![1].body);
    const sent = body.messages;

    // Assistant message has tool_calls
    expect(sent[1].role).toBe("assistant");
    expect(sent[1].tool_calls).toHaveLength(2);

    // Each tool result becomes a separate "tool" message
    expect(sent[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "file.ts" });
    expect(sent[3]).toEqual({ role: "tool", tool_call_id: "call_2", content: "const x = 1" });
    expect(sent).toHaveLength(4);
  });

  it("passes context role as system message", async () => {
    mockFetch.mockResolvedValueOnce(ok({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage,
    }));

    await Effect.runPromise(
      provider.chat([
        { role: "context", content: "You are helpful.", timestamp: 0 },
        { role: "user", content: "hello", timestamp: 1 },
      ])
    );

    const body = JSON.parse(mockFetch.mock.lastCall![1].body);
    expect(body.messages[0]).toEqual({ role: "system", content: "You are helpful." });
  });
});
