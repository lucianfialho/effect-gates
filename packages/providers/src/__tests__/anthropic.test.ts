import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { makeAnthropicProvider } from "../anthropic/index.js";
import type { Message } from "../types.js";

// Intercept fetch to verify request format without hitting the API
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const makeOkResponse = (body: unknown) =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as Response);

const provider = makeAnthropicProvider({ apiKey: "test-key" });

describe("Anthropic provider", () => {
  it("sends tools in input_schema format", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
    }));

    await Effect.runPromise(
      provider.chat(
        [{ role: "user", content: "hello", timestamp: 0 }],
        [{ name: "bash", description: "Run bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }]
      )
    );

    const body = JSON.parse(mockFetch.mock.lastCall[1].body);
    expect(body.tools[0]).toEqual({
      name: "bash",
      description: "Run bash",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    });
    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("parses tool_use blocks into toolCalls", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
      ],
      usage: { input_tokens: 20, output_tokens: 15 },
      stop_reason: "tool_use",
    }));

    const result = await Effect.runPromise(
      provider.chat([{ role: "user", content: "list files", timestamp: 0 }], [])
    );

    expect(result.content).toBe("let me check");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({ id: "call_1", name: "bash", arguments: '{"command":"ls"}' });
  });

  it("converts tool result messages to tool_result blocks", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 30, output_tokens: 10 },
      stop_reason: "end_turn",
    }));

    const messages: Message[] = [
      { role: "user", content: "list files", timestamp: 0 },
      {
        role: "assistant",
        content: "let me check",
        timestamp: 1,
        toolCalls: [{ id: "call_1", name: "bash", arguments: '{"command":"ls"}' }],
      },
      {
        role: "user",
        content: "",
        timestamp: 2,
        toolResults: [{ toolCallId: "call_1", content: "file.ts\nREADME.md" }],
      },
    ];

    await Effect.runPromise(provider.chat(messages));

    const body = JSON.parse(mockFetch.mock.lastCall[1].body);
    const sentMessages = body.messages;

    // User with tool_result block
    const toolResultMsg = sentMessages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_1",
      content: "file.ts\nREADME.md",
    });

    // Assistant with tool_use block
    const assistantMsg = sentMessages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toContainEqual({
      type: "tool_use",
      id: "call_1",
      name: "bash",
      input: { command: "ls" },
    });
  });

  it("handles stop_reason tool_use with no text content", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      content: [{ type: "tool_use", id: "x", name: "read", input: { path: "foo.ts" } }],
      usage: { input_tokens: 10, output_tokens: 8 },
      stop_reason: "tool_use",
    }));

    const result = await Effect.runPromise(
      provider.chat([{ role: "user", content: "read foo.ts", timestamp: 0 }])
    );

    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("read");
  });
});
