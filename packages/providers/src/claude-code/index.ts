import { Effect } from "effect";
import type { Provider, ProviderError, Message, ChatResponse } from "../types.js";

// ── Config ─────────────────────────────────────────────────────────────────────

export interface ClaudeCodeConfig {
  /** Model to use. Defaults to claude-sonnet-4-6. */
  readonly model?: string;
  /**
   * Tools Claude is allowed to use without prompting.
   * Uses Claude Code built-in tool names: Bash, Read, Write, Edit, Glob, Grep.
   * Custom tools: mcp__<server>__<tool>
   * Default: ["Bash", "Read", "Glob", "Grep"] — safe for read-only investigation.
   */
  readonly allowedTools?: string[];
  /**
   * Path to the claude binary. Default: "claude" (assumes it's in PATH).
   */
  readonly claudeBin?: string;
  /**
   * Working directory for claude -p. Default: process.cwd().
   */
  readonly cwd?: string;
  /**
   * Timeout in ms for each claude -p call. Default: 120_000 (2 min).
   */
  readonly timeoutMs?: number;
  /**
   * Use --system-prompt instead of --append-system-prompt.
   * When true, replaces Claude Code's default system prompt entirely.
   * When false (default), appends to it.
   */
  readonly replaceSystemPrompt?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

interface ClaudeResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    server_tool_use?: Record<string, number>;
  };
}

const spawnClaude = (
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    import("node:child_process").then(({ spawn }) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      // stdio: ['ignore', ...] closes stdin — equivalent to < /dev/null
      // Without this, claude -p waits 3s for piped input before proceeding
      const proc = spawn("claude", args, { cwd, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });

      proc.stdout.on("data", (d: Buffer) => chunks.push(d));
      proc.stderr.on("data", (d: Buffer) => errChunks.push(d));

      proc.on("close", (code) => {
        const out = Buffer.concat(chunks).toString("utf-8").trim();
        const err = Buffer.concat(errChunks).toString("utf-8").trim();
        if (code !== 0) {
          reject(new Error(`claude exited ${code}: ${err || out || "(no output)"}`));
        } else {
          resolve(out);
        }
      });

      proc.on("error", (e) => reject(e));
    });
  });

// ── Provider ───────────────────────────────────────────────────────────────────

/**
 * Provider that runs `claude -p` as a subprocess.
 *
 * Why: OAuth tokens (sk-ant-oat01) used directly against api.anthropic.com
 * share the subscription quota but are subject to API-tier rate limits.
 * Running via the `claude` binary uses the subscription routing directly,
 * giving full Pro/Max rate limits.
 *
 * Tool calling: Claude Code handles built-in tools (Bash, Read, Glob, Grep, etc.)
 * internally. Custom tools can be added via MCP servers. The provider does not
 * surface intermediate tool calls to the harness — only the final result.
 *
 * Session continuity: the provider tracks `session_id` from each response and
 * passes `--resume session_id` on subsequent calls, preserving conversation
 * history inside Claude Code's session storage.
 *
 * @example
 * const provider = makeClaudeCodeProvider({
 *   model: "claude-sonnet-4-6",
 *   allowedTools: ["Bash", "Read", "Glob", "Grep"],
 * });
 */
export const makeClaudeCodeProvider = (config: ClaudeCodeConfig = {}): Provider => {
  const claudeBin  = config.claudeBin ?? "claude";
  const cwd        = config.cwd ?? process.cwd();
  const timeoutMs  = config.timeoutMs ?? 120_000;
  const tools      = config.allowedTools ?? ["Bash", "Read", "Glob", "Grep"];
  const model      = config.model ?? "claude-sonnet-4-6";
  const systemFlag = config.replaceSystemPrompt ? "--system-prompt" : "--append-system-prompt";

  // Session state: persists across chat() calls within the same provider instance
  let sessionId: string | null = null;

  return {
    id: "claude-code",

    chat: (messages: Message[]): Effect.Effect<ChatResponse, ProviderError> =>
      Effect.tryPromise({
        try: async () => {
          // Extract system prompt and last user message
          const systemMsg = messages.find(
            (m) => m.role === "system" || m.role === "context"
          );
          const lastUser = [...messages]
            .reverse()
            .find((m) => m.role === "user")?.content ?? "";

          const args: string[] = [
            "-p", lastUser,
            "--model", model,
            "--output-format", "json",
            "--allowedTools", tools.join(","),
          ];

          // Append/replace system prompt on first call or always
          if (systemMsg?.content) {
            args.push(systemFlag, systemMsg.content);
          }

          // Resume existing session for conversation continuity
          if (sessionId) {
            args.push("--resume", sessionId);
          }

          const raw = await spawnClaude(args, cwd, timeoutMs);

          let parsed: ClaudeResult;
          try {
            parsed = JSON.parse(raw) as ClaudeResult;
          } catch {
            throw new Error(`Failed to parse claude output: ${raw.slice(0, 300)}`);
          }

          if (parsed.is_error || parsed.subtype === "error") {
            throw new Error(`Claude Code error: ${parsed.result}`);
          }

          // Persist session ID for next turn
          if (parsed.session_id) {
            sessionId = parsed.session_id;
          }

          return {
            content: parsed.result ?? "",
            usage: {
              inputTokens:  parsed.usage?.input_tokens ?? 0,
              outputTokens: parsed.usage?.output_tokens ?? 0,
              totalTokens:  (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0),
            },
            cost: parsed.total_cost_usd ?? 0,
          } satisfies ChatResponse;
        },
        catch: (e): ProviderError => ({
          code: "CLAUDE_CODE_ERROR",
          message: e instanceof Error ? e.message : String(e),
        }),
      }),
  };
};
