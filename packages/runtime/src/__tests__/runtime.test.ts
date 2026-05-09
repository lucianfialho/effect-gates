import { describe, it, expect, beforeEach, vi } from "vitest";
import { Effect } from "effect";
import { makeAgent } from "../runtime.js";
import type { Provider, ChatResponse } from "../index.js";

const mockProvider: Provider = {
  id: "test",
  chat: (messages) =>
    Effect.succeed({
      content: `Echo: ${messages[messages.length - 1]?.content ?? ""}`,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
      cost: 0.001,
    } satisfies ChatResponse),
};

describe("Runtime", () => {
  describe("makeAgent", () => {
    it("should create agent with run method", async () => {
      const agent = await Effect.runPromise(
        makeAgent({
          model: "test-model",
          provider: mockProvider,
        })
      );

      expect(agent).toBeDefined();
      expect(typeof agent.run).toBe("function");
    });

    it("should run prompt and return response", async () => {
      const agent = await Effect.runPromise(
        makeAgent({
          model: "test-model",
          provider: mockProvider,
          systemPrompt: "You are a helpful assistant.",
        })
      );

      const result = await Effect.runPromise(agent.run("Hello"));

      expect(result.content).toBe("Echo: Hello");
      expect(result.session).toBeDefined();
      expect(result.usage.totalTokens).toBe(30);
      expect(result.cost).toBe(0.001);
    });

    it("should resume session with existing messages", async () => {
      const agent = await Effect.runPromise(
        makeAgent({
          model: "test-model",
          provider: mockProvider,
        })
      );

      const first = await Effect.runPromise(agent.run("First"));
      const second = await Effect.runPromise(agent.resume(first.session.id, "Second"));

      expect(second.session.messages.length).toBeGreaterThanOrEqual(2);
      expect(second.session.id).toBe(first.session.id);
    });

    it("should fail when session not found", async () => {
      const agent = await Effect.runPromise(
        makeAgent({
          model: "test-model",
          provider: mockProvider,
        })
      );

      const result = await Effect.runPromise(
        Effect.result(agent.resume("non-existent-id", "Hello"))
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("SESSION_NOT_FOUND");
      }
    });
  });
});