import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { stream } from "hono/streaming";
import { Effect } from "effect";
import { makeMiniMaxProvider, makeAnthropicProvider, makeOpenAIProvider } from "@gates-effect/providers";
import type { Provider } from "@gates-effect/providers";
import { makeFileSessionStore, SessionHistory } from "@gates-effect/runtime";
import type { Message } from "@gates-effect/runtime";
import type { Message as ProviderMessage } from "@gates-effect/providers";

const toProviderMessage = (m: Message): ProviderMessage => ({
  role: (m.role === "tool" ? "user" : m.role === "context" ? "system" : m.role) as ProviderMessage["role"],
  content: m.content,
  timestamp: m.timestamp,
});
import type { LoadedHarness } from "../harness/loader.js";
import type { HarnessConfig } from "../harness/define.js";

export const DEFAULT_PORT = 3583;

// ── Provider factory using @gates-effect/providers ───────────────────────────

function makeProvider(config: HarnessConfig): Provider {
  const apiKey =
    config.provider.apiKey ??
    process.env[`${config.provider.type.toUpperCase()}_API_KEY`] ??
    "";
  switch (config.provider.type) {
    case "anthropic": return makeAnthropicProvider({ apiKey, model: config.provider.model });
    case "openai":    return makeOpenAIProvider({ apiKey, model: config.provider.model });
    case "minimax":
    default:          return makeMiniMaxProvider({ apiKey, model: config.provider.model });
  }
}

// ── Session registry ─────────────────────────────────────────────────────────

const sessions = new Map<string, { harnessName: string; createdAt: number }>();

const sse = (type: string, data: unknown): string =>
  `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

// ── App ───────────────────────────────────────────────────────────────────────

export function createServer(harnesses: LoadedHarness[]) {
  const app = new Hono();

  app.get("/api/harnesses", (c) =>
    c.json(
      harnesses.map((h) => ({
        name: h.name,
        description: h.config.description ?? "",
        provider: h.config.provider.type,
        model: h.config.provider.model ?? "",
      }))
    )
  );

  app.post("/api/sessions", async (c) => {
    const { harnessName } = await c.req.json<{ harnessName: string }>();
    if (!harnesses.find((h) => h.name === harnessName))
      return c.json({ error: "Harness not found" }, 404);
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { harnessName, createdAt: Date.now() });
    return c.json({ sessionId });
  });

  app.get("/api/sessions", (c) =>
    c.json(
      [...sessions.entries()].map(([id, meta]) => ({
        id,
        harnessName: meta.harnessName,
        createdAt: meta.createdAt,
      }))
    )
  );

  app.post("/api/sessions/:id/chat", (c) => {
    const sessionId = c.req.param("id");
    return stream(c, async (s) => {
      const write = (type: string, data: unknown) => s.write(sse(type, data));
      try {
        const { content, role: roleOverride } = await c.req.json<{
          content: string;
          role?: string;
        }>();

        const meta = sessions.get(sessionId);
        if (!meta) { await write("error", { message: "Session not found" }); return; }

        const loaded = harnesses.find((h) => h.name === meta.harnessName);
        if (!loaded) { await write("error", { message: "Harness not found" }); return; }

        await write("start", { sessionId });
        await write("thinking", {});

        const provider = makeProvider(loaded.config);

        // Load persisted history via @gates-effect/runtime SessionHistory
        const store = await Effect.runPromise(makeFileSessionStore());
        const storageKey = `harness-ui:${sessionId}`;
        const existing = await Effect.runPromise(store.load(storageKey));
        const history = await Effect.runPromise(SessionHistory.fromData(existing));
        const contextMessages = await Effect.runPromise(history.buildContext());

        // Resolve system prompt from role or config
        const activeRole = roleOverride ?? loaded.config.defaultRole;
        const systemPrompt =
          loaded.config.roles?.find((r) => r.name === activeRole)?.systemPrompt ??
          loaded.config.systemPrompt ??
          "You are a helpful assistant.";

        // Build full message list: system + history + new user message
        const messages: Message[] = [
          { id: crypto.randomUUID(), role: "system", content: systemPrompt, timestamp: Date.now() },
          ...contextMessages,
          { id: crypto.randomUUID(), role: "user", content, timestamp: Date.now() },
        ];

        const result = await Effect.runPromise(provider.chat(messages.map(toProviderMessage)));

        // Persist: append user + assistant to SessionHistory
        const userMsg: Message = { id: crypto.randomUUID(), role: "user", content, timestamp: Date.now() };
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: result.content,
          timestamp: Date.now() + 1,
        };
        await Effect.runPromise(history.appendMessage(userMsg, "user"));
        await Effect.runPromise(history.appendMessage(assistantMsg, "prompt"));
        const data = await Effect.runPromise(history.toData({ sessionId }));
        await Effect.runPromise(store.save(storageKey, data));

        // Stream response word by word
        for (const word of result.content.split(/(\s+)/)) {
          if (word) {
            await write("delta", { text: word });
            await new Promise((r) => setTimeout(r, 8));
          }
        }
        await write("done", { content: result.content, usage: result.usage });
      } catch (err) {
        await write("error", { message: String(err) });
      }
    });
  });

  app.get("/api/sessions/:id/history", async (c) => {
    const sessionId = c.req.param("id");
    const store = await Effect.runPromise(makeFileSessionStore());
    const data = await Effect.runPromise(store.load(`harness-ui:${sessionId}`));
    if (!data) return c.json({ messages: [] });
    const history = await Effect.runPromise(SessionHistory.fromData(data));
    const messages = await Effect.runPromise(history.buildContext());
    return c.json({ messages });
  });

  return app;
}

export async function startServer(
  harnesses: LoadedHarness[],
  port = DEFAULT_PORT
): Promise<() => void> {
  const app = createServer(harnesses);
  const server = serve({ fetch: app.fetch, port });
  return () => server.close();
}
