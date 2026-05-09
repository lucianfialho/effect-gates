import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import { makeMiniMaxProvider } from "../minimax/index.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = mockFetch;
});

describe("MiniMax Provider", () => {
  it("should return provider with correct id", () => {
    const provider = makeMiniMaxProvider({ apiKey: "test-key" });
    expect(provider.id).toBe("minimax");
  });

  it("should handle successful response", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        id: "test-id",
        object: "chat.completion",
        created: 1234567890,
        model: "MiniMax-Text-01",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello from MiniMax",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
    };

    mockFetch.mockResolvedValue(mockResponse);

    const provider = makeMiniMaxProvider({ apiKey: "test-key" });
    const result = await Effect.runPromise(
      provider.chat([{ role: "user", content: "Hi", timestamp: Date.now() }])
    );

    expect(result.content).toBe("Hello from MiniMax");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(20);
    expect(result.usage.totalTokens).toBe(30);
  });

  it("should handle API error", async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue("Unauthorized"),
    };

    mockFetch.mockResolvedValue(mockResponse);

    const provider = makeMiniMaxProvider({ apiKey: "bad-key" });
    const result = await Effect.runPromise(
      Effect.result(provider.chat([{ role: "user", content: "Hi", timestamp: Date.now() }]))
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("MINIMAX_ERROR");
    }
  });
});