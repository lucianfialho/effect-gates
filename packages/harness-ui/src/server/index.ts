import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { stream } from "hono/streaming";
import { Effect } from "effect";
import { makeMiniMaxProvider, makeAnthropicProvider, makeOpenAIProvider } from "@gates-effect/providers";
import type { Provider, Tool as ProviderTool } from "@gates-effect/providers";
import { makeFileSessionStore, SessionHistory, toolsMap } from "@gates-effect/runtime";
import type { Message } from "@gates-effect/runtime";
import type { Message as ProviderMessage, ToolCall } from "@gates-effect/providers";
import { makeLocalSandbox } from "@gates-effect/sandbox";
import type { LoadedHarness } from "../harness/loader.js";
import type { HarnessConfig } from "../harness/define.js";

export const DEFAULT_PORT = 3583;
const MAX_TOOL_ITERATIONS = 10;

// ── Provider factory ─────────────────────────────────────────────────────────

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

// ── Message type bridge ───────────────────────────────────────────────────────

const toProviderMessage = (m: Message): ProviderMessage => ({
  role: (m.role === "tool" ? "user" : m.role === "context" ? "system" : m.role) as ProviderMessage["role"],
  content: m.content,
  timestamp: m.timestamp,
});

// ── Session registry ─────────────────────────────────────────────────────────

const sessions = new Map<string, { harnessName: string; createdAt: number }>();
const sse = (type: string, data: unknown): string =>
  `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

// ── App ───────────────────────────────────────────────────────────────────────

export function createServer(harnesses: LoadedHarness[]) {
  const app = new Hono();

  app.get("/api/harnesses", (c) =>
    c.json(harnesses.map((h) => ({
      name: h.name,
      description: h.config.description ?? "",
      provider: h.config.provider.type,
      model: h.config.provider.model ?? "",
      tools: h.config.tools ?? [],
    })))
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
    c.json([...sessions.entries()].map(([id, meta]) => ({
      id, harnessName: meta.harnessName, createdAt: meta.createdAt,
    })))
  );

  app.post("/api/sessions/:id/chat", (c) => {
    const sessionId = c.req.param("id");
    return stream(c, async (s) => {
      const write = (type: string, data: unknown) => s.write(sse(type, data));
      try {
        const { content, role: roleOverride } = await c.req.json<{
          content: string; role?: string;
        }>();

        const meta = sessions.get(sessionId);
        if (!meta) { await write("error", { message: "Session not found" }); return; }

        const loaded = harnesses.find((h) => h.name === meta.harnessName);
        if (!loaded) { await write("error", { message: "Harness not found" }); return; }

        await write("start", { sessionId });
        await write("thinking", {});

        const provider = makeProvider(loaded.config);

        // Load persisted history
        const store = await Effect.runPromise(makeFileSessionStore());
        const storageKey = `harness-ui:${sessionId}`;
        const existing = await Effect.runPromise(store.load(storageKey));
        const history = await Effect.runPromise(SessionHistory.fromData(existing));
        const contextMessages = await Effect.runPromise(history.buildContext());

        const activeRole = roleOverride ?? loaded.config.defaultRole;
        const systemPrompt =
          loaded.config.roles?.find((r) => r.name === activeRole)?.systemPrompt ??
          loaded.config.systemPrompt ?? "You are a helpful assistant.";

        // Set up sandbox + tools (only those declared in harness config)
        const sandbox = await Effect.runPromise(makeLocalSandbox({ cwd: process.cwd() }));
        const allTools = toolsMap(sandbox);
        const declaredToolNames = loaded.config.tools ?? [];

        const providerTools: ProviderTool[] = declaredToolNames
          .flatMap((name) => {
            const t = allTools.get(name);
            return t ? [{ name: t.name, description: t.description, parameters: t.parameters }] : [];
          });

        // Initial message list
        const currentMessages: ProviderMessage[] = [
          { role: "system", content: systemPrompt, timestamp: Date.now() },
          ...contextMessages.map(toProviderMessage),
          { role: "user", content, timestamp: Date.now() },
        ];

        let finalContent = "";
        let iteration = 0;

        // ── Agent loop ─────────────────────────────────────────────────────
        while (iteration < MAX_TOOL_ITERATIONS) {
          const result = await Effect.runPromise(
            provider.chat(currentMessages, providerTools.length > 0 ? providerTools : undefined)
          );
          finalContent = result.content;

          if (!result.toolCalls?.length) break;

          // Execute each tool call, streaming events as we go
          const toolResults: Array<{ tc: ToolCall; output: string; isError: boolean }> = [];

          for (const tc of result.toolCalls) {
            await write("tool_call", { id: tc.id, name: tc.name, args: tc.arguments });

            const tool = allTools.get(tc.name);
            let output: string;
            let isError = false;

            if (tool) {
              let params: Record<string, unknown> = {};
              try { params = JSON.parse(tc.arguments); } catch { params = {}; }
              const execResult = await Effect.runPromise(Effect.result(tool.execute(params)));
              if (execResult._tag === "Success") {
                output = execResult.success.content.slice(0, 2000);
                isError = execResult.success.isError ?? false;
              } else {
                output = `Tool execution failed: ${String(execResult.failure)}`;
                isError = true;
              }
            } else {
              output = `Tool "${tc.name}" not available`;
              isError = true;
            }

            await write("tool_result", { id: tc.id, name: tc.name, output, isError });
            toolResults.push({ tc, output, isError });
          }

          // Append assistant + tool results to conversation
          currentMessages.push({
            role: "assistant",
            content: result.content,
            timestamp: Date.now(),
            toolCalls: result.toolCalls,
          });
          currentMessages.push({
            role: "user",
            content: "",
            timestamp: Date.now() + 1,
            toolResults: toolResults.map(({ tc, output, isError }) => ({
              toolCallId: tc.id,
              content: output,
              isError,
            })),
          });

          iteration++;
        }

        // Persist: user message + final assistant response
        const userMsg: Message = { id: crypto.randomUUID(), role: "user", content, timestamp: Date.now() };
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: finalContent,
          timestamp: Date.now() + 1,
        };
        await Effect.runPromise(history.appendMessage(userMsg, "user"));
        await Effect.runPromise(history.appendMessage(assistantMsg, "prompt"));
        const data = await Effect.runPromise(history.toData({ sessionId }));
        await Effect.runPromise(store.save(storageKey, data));

        // Stream final response word by word
        for (const word of finalContent.split(/(\s+)/)) {
          if (word) {
            await write("delta", { text: word });
            await new Promise((r) => setTimeout(r, 8));
          }
        }
        await write("done", { content: finalContent, usage: { totalTokens: 0 }, iterations: iteration });
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
