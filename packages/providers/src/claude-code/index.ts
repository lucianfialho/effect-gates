import { Effect } from "effect";
import type { Provider, ProviderError, Message, ChatResponse, ProviderStreamEvent } from "../types.js";

// ── Config ─────────────────────────────────────────────────────────────────────

export interface ClaudeCodeConfig {
  readonly model?: string;
  /**
   * Claude Code built-in tool names: Bash, Read, Write, Edit, Glob, Grep.
   * Default: ["Bash", "Read", "Glob", "Grep"]
   */
  readonly allowedTools?: string[];
  readonly claudeBin?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /**
   * --system-prompt replaces Claude Code's default.
   * --append-system-prompt (default) extends it.
   */
  readonly replaceSystemPrompt?: boolean;
}

// ── Stream event types from claude -p stream-json ────────────────────────────

interface StreamLine {
  type: string;
  subtype?: string;
  event?: {
    type: string;
    index?: number;
    content_block?: { type: string; id?: string; name?: string; input?: unknown };
    delta?: { type: string; text?: string; partial_json?: string };
  };
  // final result line
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  is_error?: boolean;
}

// ── Provider ───────────────────────────────────────────────────────────────────

/**
 * Provider that spawns `claude -p` using subscription OAuth — no API rate limits.
 *
 * Streaming: uses `--output-format stream-json --verbose --include-partial-messages`
 * to emit events in real-time:
 *   - tool_call: when Claude starts a tool (Bash, Read, Glob, Grep…)
 *   - delta:     text tokens as they arrive
 *
 * Tool RESULTS are handled internally by Claude Code and not surfaced.
 */
export const makeClaudeCodeProvider = (config: ClaudeCodeConfig = {}): Provider => {
  const bin       = config.claudeBin ?? "claude";
  const cwd       = config.cwd ?? process.cwd();
  const timeout   = config.timeoutMs ?? 180_000;
  const tools     = config.allowedTools ?? ["Bash", "Read", "Glob", "Grep"];
  const model     = config.model ?? "claude-sonnet-4-6";
  const sysFlag   = config.replaceSystemPrompt ? "--system-prompt" : "--append-system-prompt";

  let sessionId: string | null = null;

  return {
    id: "claude-code",

    chat: (
      messages: Message[],
      _tools?: unknown,
      onEvent?: (e: ProviderStreamEvent) => void
    ): Effect.Effect<ChatResponse, ProviderError> =>
      Effect.tryPromise({
        try: () => new Promise<ChatResponse>((resolve, reject) => {
          import("node:child_process").then(({ spawn }) => {
            import("node:readline").then(({ createInterface }) => {
              const systemMsg = messages.find((m) => m.role === "system" || m.role === "context");
              const lastUser  = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

              const args: string[] = [
                "-p", lastUser,
                "--model", model,
                "--output-format", "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--allowedTools", tools.join(","),
              ];

              if (systemMsg?.content) args.push(sysFlag, systemMsg.content);
              if (sessionId) args.push("--resume", sessionId);

              const proc = spawn(bin, args, {
                cwd,
                timeout,
                stdio: ["ignore", "pipe", "pipe"],
              });

              // Accumulate tool input JSON per content block index
              const toolInputBuffers = new Map<number, { id: string; name: string; json: string }>();
              let finalContent = "";
              let finalSessionId: string | null = null;
              let totalCost = 0;
              let inputTokens = 0;
              let outputTokens = 0;

              const rl = createInterface({ input: proc.stdout! });

              rl.on("line", (line) => {
                if (!line.trim()) return;
                let parsed: StreamLine;
                try { parsed = JSON.parse(line) as StreamLine; }
                catch { return; }

                // ── Final result line ──────────────────────────────────────
                if (parsed.type === "result") {
                  finalContent   = parsed.result ?? "";
                  finalSessionId = parsed.session_id ?? null;
                  totalCost      = parsed.total_cost_usd ?? 0;
                  inputTokens    = parsed.usage?.input_tokens ?? 0;
                  outputTokens   = parsed.usage?.output_tokens ?? 0;
                  return;
                }

                if (parsed.type !== "stream_event" || !parsed.event) return;
                const ev = parsed.event;

                // ── Tool call start ────────────────────────────────────────
                if (
                  ev.type === "content_block_start" &&
                  ev.content_block?.type === "tool_use" &&
                  ev.index != null
                ) {
                  const id   = ev.content_block.id ?? crypto.randomUUID();
                  const name = ev.content_block.name ?? "unknown";
                  toolInputBuffers.set(ev.index, { id, name, json: "" });
                  return;
                }

                // ── Tool input delta (accumulate JSON) ─────────────────────
                if (
                  ev.type === "content_block_delta" &&
                  ev.delta?.type === "input_json_delta" &&
                  ev.index != null
                ) {
                  const buf = toolInputBuffers.get(ev.index);
                  if (buf) buf.json += ev.delta.partial_json ?? "";
                  return;
                }

                // ── Tool block complete → emit tool_call ───────────────────
                if (ev.type === "content_block_stop" && ev.index != null) {
                  const buf = toolInputBuffers.get(ev.index);
                  if (buf) {
                    onEvent?.({ type: "tool_call", id: buf.id, name: buf.name, args: buf.json });
                    toolInputBuffers.delete(ev.index);
                  }
                  return;
                }

                // ── Text delta ─────────────────────────────────────────────
                if (
                  ev.type === "content_block_delta" &&
                  ev.delta?.type === "text_delta" &&
                  ev.delta.text
                ) {
                  onEvent?.({ type: "delta", text: ev.delta.text });
                }
              });

              proc.on("error", reject);

              proc.on("close", (code) => {
                if (code !== 0 && !finalContent) {
                  const errOut: Buffer[] = [];
                  // stderr already consumed — include any partial data
                  return reject(new Error(`claude exited ${code}`));
                }

                if (finalSessionId) sessionId = finalSessionId;

                resolve({
                  content: finalContent,
                  usage: {
                    inputTokens,
                    outputTokens,
                    totalTokens: inputTokens + outputTokens,
                  },
                  cost: totalCost,
                });
              });
            });
          });
        }),
        catch: (e): ProviderError => ({
          code: "CLAUDE_CODE_ERROR",
          message: e instanceof Error ? e.message : String(e),
        }),
      }),
  };
};
