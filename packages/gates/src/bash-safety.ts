import { Effect } from "effect";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+/,
  /dd\s+/,
  /mkfs/,
  />\s*\/(dev|proc|sys)/,
  /:(){ :|:& };:/,
  /chmod\s+777\s+/,
  /chown\s+/,
  /\|\s*sh$/,
];

const ALLOWED_COMMANDS = [
  "ls", "cat", "grep", "find", "echo", "pwd", "cd", "mkdir", "touch",
  "git", "npm", "pnpm", "node", "python", "python3", "cargo", "rustc",
];

export interface BashSafetyConfig {
  readonly allowedPaths?: string[];
  readonly maxOutputSize?: number;
}

export class BashSafetyError {
  readonly _tag = "BashSafetyError";
  constructor(
    readonly code: string,
    readonly message: string
  ) {}
}

export const bashSafety = (config: BashSafetyConfig = {}) => {
  const maxOutputSize = config.maxOutputSize ?? 1024 * 1024;

  return (command: string): Effect.Effect<void, BashSafetyError> =>
    Effect.gen(this, function* () {
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          return yield* Effect.fail(new BashSafetyError(
            "DANGEROUS_PATTERN",
            `Command matches dangerous pattern: ${pattern}`
          ));
        }
      }

      const firstWord = command.trim().split(/\s+/)[0];
      if (!ALLOWED_COMMANDS.includes(firstWord) && !firstWord.startsWith("./")) {
        return yield* Effect.fail(new BashSafetyError(
          "UNKNOWN_COMMAND",
          `Command "${firstWord}" is not in the allowed list`
        ));
      }

      return;
    });
};

export const runBash = (
  command: string,
  config: BashSafetyConfig = {}
): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, BashSafetyError | Error> =>
  Effect.gen(this, function* () {
    const safety = bashSafety(config);
    yield* safety(command);

    return yield* Effect.tryPromise({
      try: async () => {
        const { stdout, stderr } = await execAsync(command);
        return { stdout, stderr, exitCode: 0 };
      },
      catch: (error) => new BashSafetyError("EXEC_ERROR", String(error)),
    });
  });
