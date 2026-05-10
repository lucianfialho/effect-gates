import { Effect } from "effect";
import type { Tool, ToolResult } from "./tools.js";
import { toolResult, toolError } from "./tools.js";

export interface CommandConfig {
  /** Tool name as seen by the LLM */
  readonly name: string;
  /** Description for the LLM */
  readonly description: string;
  /** The executable to run (e.g. "git", "npm", "docker") */
  readonly executable: string;
  /**
   * If provided, only these subcommands (first word of args) are accepted.
   * Example: ["status", "log", "diff"] for git.
   */
  readonly allowedSubcommands?: readonly string[];
  /**
   * Base args always prepended before user-supplied args.
   * Example: ["--no-pager"] for git.
   */
  readonly baseArgs?: readonly string[];
  /**
   * Environment variables available to this command.
   * Only PATH/HOME and these entries are passed — process.env is NOT leaked.
   */
  readonly env?: Record<string, string | undefined>;
  /** Working directory (defaults to process.cwd()) */
  readonly cwd?: string;
  /** Timeout in ms (default: 30000) */
  readonly timeout?: number;
}

const SAFE_BASE_KEYS = [
  "PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME",
  "SHELL", "TMPDIR", "TMP", "TEMP",
] as const;

const buildIsolatedEnv = (env?: Record<string, string | undefined>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const key of SAFE_BASE_KEYS) {
    const val = process.env[key];
    if (val) result[key] = val;
  }
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      // Skip empty strings — lets CLIs use their own stored auth (e.g. ~/.config/gws/)
      if (v !== undefined && v !== "") result[k] = v;
    }
  }
  return result;
};

const spawnIsolated = (
  executable: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeout: number }
): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const { spawn } = await import("node:child_process");
      return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const proc = spawn(executable, args, {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeout,
        });
        proc.stdout.on("data", (d: Buffer) => chunks.push(d));
        proc.stderr.on("data", (d: Buffer) => chunks.push(d));
        proc.on("close", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        proc.on("error", reject);
      });
    },
    catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
  });

/** Shell-aware argument splitter: handles single and double quoted strings. */
function shellSplitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) { quote = null; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Creates a Tool that runs a specific external CLI with an isolated environment.
 *
 * Unlike makeBashTool (which accepts arbitrary shell commands), defineCommand:
 * - Runs only the declared executable
 * - Optionally restricts to an allowlist of subcommands
 * - Never leaks process.env — only PATH/HOME + explicit env entries are passed
 *
 * @example
 * const git = defineCommand({
 *   name: "git",
 *   description: "Run git operations on the repository",
 *   executable: "git",
 *   allowedSubcommands: ["status", "log", "diff", "add", "commit", "push", "pull"],
 *   baseArgs: ["--no-pager"],
 *   env: { GIT_AUTHOR_NAME: "Agent", GIT_AUTHOR_EMAIL: "agent@local" },
 *   cwd: process.cwd(),
 * });
 */
export const defineCommand = (config: CommandConfig): Tool => ({
  name: config.name,
  description: config.description,
  parameters: {
    type: "object",
    properties: {
      args: {
        type: "string",
        description: `Arguments to pass to ${config.executable}. Example: "status -s" or "log --oneline -10"`,
      },
    },
    required: [],
  },
  execute: (params: Record<string, unknown>): Effect.Effect<ToolResult> =>
    Effect.gen(function* () {
      const rawArgs = String(params["args"] ?? "").trim();
      const userArgs = rawArgs.length > 0 ? shellSplitArgs(rawArgs) : [];

      if (config.allowedSubcommands && userArgs.length > 0) {
        const sub = userArgs[0]!;
        if (!config.allowedSubcommands.includes(sub)) {
          return toolError(
            `Subcommand "${sub}" is not allowed for "${config.name}". ` +
            `Allowed: ${config.allowedSubcommands.join(", ")}`
          );
        }
      }

      const allArgs = [...(config.baseArgs ?? []), ...userArgs];
      const env = buildIsolatedEnv(config.env);
      const cwd = config.cwd ?? process.cwd();
      const timeout = config.timeout ?? 30000;

      const result = yield* Effect.result(spawnIsolated(config.executable, allArgs, { cwd, env, timeout }));

      if (result._tag === "Failure") {
        return toolError(`${config.name} failed: ${result.failure.message}`);
      }

      return toolResult(result.success || "(empty output)", {
        command: `${config.executable} ${allArgs.join(" ")}`.trim(),
      });
    }),
});
