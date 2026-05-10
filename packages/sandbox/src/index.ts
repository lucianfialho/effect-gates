import { Effect } from "effect";
import * as nodeProcess from "node:process";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

export interface SandboxConfig {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeout?: number;
  /**
   * Secrets explicitly granted to this sandbox (e.g. GITHUB_TOKEN, NPM_TOKEN).
   * Always overlaid on top of env, never exposed to the outside.
   */
  readonly credentials?: Record<string, string>;
  /**
   * When false, commands receive the full process.env (opt-in credential leakage).
   * Defaults to true (safe baseline: only PATH/HOME and a small allow-list are
   * passed, plus `env` and `credentials`). Set to false only when you explicitly
   * want the parent process environment forwarded to the sandbox.
   *
   * Fix #19: previously the logic was inverted — `isolated: true` was required to
   * be safe. Now the safe baseline is the default; pass `isolated: false` to opt
   * into leaking process.env.
   */
  readonly isolated?: boolean;
  /**
   * When true, `run()` may execute arbitrary shell commands (e.g. cd /, absolute
   * paths). This flag is intentionally advisory: full shell restriction is
   * impractical at the exec level. Real isolation should be achieved via
   * `defineCommand` allow-lists. Defaults to false for documentation purposes.
   *
   * Fix #18: documents the limitation; real cwd containment for file operations
   * is handled separately via `assertWithinCwd`.
   */
  readonly allowArbitraryCommands?: boolean;
}

export interface Sandbox {
  readonly run: (command: string) => Effect.Effect<string, SandboxError>;
  readonly writeFile: (path: string, content: string) => Effect.Effect<void, SandboxError>;
  readonly readFile: (path: string) => Effect.Effect<string, SandboxError>;
  readonly listDir: (path: string) => Effect.Effect<string[], SandboxError>;
  readonly exists: (path: string) => Effect.Effect<boolean, SandboxError>;
  readonly cwd: string;
}

export interface SandboxError {
  readonly code: string;
  readonly message: string;
}

export const SandboxError = {
  FileNotFound: (path: string): SandboxError => ({
    code: "FILE_NOT_FOUND",
    message: `File not found: ${path}`,
  }),
  PermissionDenied: (path: string): SandboxError => ({
    code: "PERMISSION_DENIED",
    message: `Permission denied: ${path}`,
  }),
  CommandFailed: (cmd: string, output: string): SandboxError => ({
    code: "COMMAND_FAILED",
    message: `Command "${cmd}" failed: ${output}`,
  }),
  Timeout: (cmd: string, ms: number): SandboxError => ({
    code: "TIMEOUT",
    message: `Command "${cmd}" timed out after ${ms}ms`,
  }),
};

export const makeInMemorySandbox = (config?: SandboxConfig): Effect.Effect<Sandbox> =>
  Effect.sync(() => {
    const cwd = config?.cwd ?? "/workspace";
    const files = new Map<string, string>([
      ["/workspace", ""],
      ["/workspace/src", ""],
      ["/workspace/tmp", ""],
    ]);

    /**
     * Fix #17: absolute paths no longer bypass the sandbox boundary.
     * All paths — relative or absolute — are resolved relative to `cwd` and
     * then checked to ensure they remain within it.
     */
    const resolvePath = (p: string): string => {
      // Resolve relative to cwd regardless of whether p is absolute.
      // path.resolve("base", "/abs") returns "/abs", so we must handle
      // absolute paths explicitly to keep them within the sandbox.
      const normalized = p.startsWith("/")
        ? path.join(cwd, p.substring(1)) // strip leading slash, join under cwd
        : path.join(cwd, p);
      // Ensure the result stays within cwd (guards against ".." sequences).
      const root = cwd.endsWith("/") ? cwd : cwd + "/";
      if (normalized !== cwd && !normalized.startsWith(root)) {
        // Return an out-of-bounds marker; callers that need an error should
        // use assertWithinCwdInMemory() below.
        return cwd; // fall back to cwd root — the Effect will fail on lookup
      }
      return normalized;
    };

    const assertWithinCwdInMemory = (p: string): SandboxError | null => {
      const normalized = p.startsWith("/")
        ? path.join(cwd, p.substring(1))
        : path.join(cwd, p);
      const root = cwd.endsWith("/") ? cwd : cwd + "/";
      if (normalized !== cwd && !normalized.startsWith(root)) {
        return SandboxError.PermissionDenied(p);
      }
      return null;
    };

    const run = (_command: string): Effect.Effect<string, SandboxError> =>
      Effect.sync(() => {
        return "[SIMULATED] Command executed in memory sandbox";
      });

    const writeFile = (filePath: string, content: string): Effect.Effect<void, SandboxError> => {
      const traversalErr = assertWithinCwdInMemory(filePath);
      if (traversalErr) return Effect.fail(traversalErr);
      return Effect.sync(() => {
        const resolved = resolvePath(filePath);
        files.set(resolved, content);
      });
    };

    const readFile = (filePath: string): Effect.Effect<string, SandboxError> => {
      const traversalErr = assertWithinCwdInMemory(filePath);
      if (traversalErr) return Effect.fail(traversalErr);
      return Effect.gen(function* () {
        const resolved = resolvePath(filePath);
        const content = files.get(resolved);
        if (content === undefined) {
          return yield* Effect.fail(SandboxError.FileNotFound(filePath));
        }
        return content;
      });
    };

    const listDir = (filePath: string): Effect.Effect<string[], SandboxError> => {
      const traversalErr = assertWithinCwdInMemory(filePath);
      if (traversalErr) return Effect.fail(traversalErr);
      return Effect.sync(() => {
        const resolved = resolvePath(filePath);
        const entries = new Set<string>();

        for (const key of files.keys()) {
          if (key.startsWith(resolved + "/") && key !== resolved) {
            const relative = key.substring(resolved.length + 1);
            const firstSlash = relative.indexOf("/");
            const entry = firstSlash === -1 ? relative : relative.substring(0, firstSlash);
            if (entry) entries.add(entry);
          }
        }

        return Array.from(entries).sort();
      });
    };

    const exists = (filePath: string): Effect.Effect<boolean, SandboxError> => {
      const traversalErr = assertWithinCwdInMemory(filePath);
      if (traversalErr) return Effect.fail(traversalErr);
      return Effect.sync(() => {
        const resolved = resolvePath(filePath);
        return files.has(resolved);
      });
    };

    return { run, writeFile, readFile, listDir, exists, cwd };
  });

const SAFE_ENV_KEYS = [
  "PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME",
  "SHELL", "TMPDIR", "TMP", "TEMP", "PWD",
] as const;

/**
 * Build the environment object passed to child processes.
 *
 * Fix #19: the previous implementation leaked process.env by default
 * (when `isolated` was falsy / undefined). The safe baseline is now the
 * DEFAULT. Pass `isolated: false` to explicitly opt into forwarding the
 * full process.env to the sandbox command.
 */
const buildCommandEnv = (config?: SandboxConfig): Record<string, string> => {
  // Opt-in: only leak process.env when the caller explicitly sets isolated:false.
  if (config?.isolated === false) {
    return {
      ...nodeProcess.env,
      ...(config?.env ?? {}),
      ...(config?.credentials ?? {}),
    } as Record<string, string>;
  }

  // Default (isolated === undefined or true): safe baseline only.
  const base: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = nodeProcess.env[key];
    if (val) base[key] = val;
  }
  return {
    ...base,
    ...(config?.env ?? {}),
    ...(config?.credentials ?? {}),
  };
};

const assertWithinCwd = (filePath: string, cwd: string): SandboxError | null => {
  const resolved = path.resolve(cwd, filePath);
  const root = path.resolve(cwd);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return SandboxError.PermissionDenied(filePath);
  }
  return null;
};

export const makeLocalSandbox = (config?: SandboxConfig): Effect.Effect<Sandbox> => {
  const cwd = config?.cwd ?? nodeProcess.cwd();
  const timeout = config?.timeout ?? 30000;
  const execAsync = promisify(child_process.exec);

  // Fix #18: full shell-level cwd containment is impractical (a command can
  // always `cd /` or use absolute paths). The `cwd` option sets the working
  // directory for the spawned process, which is the best practical guard.
  // Real isolation should be enforced via `defineCommand` allow-lists.
  // Set `allowArbitraryCommands: true` in SandboxConfig to acknowledge this
  // limitation explicitly; when false (default) a warning is emitted so
  // callers are aware of the advisory-only nature of shell containment.
  const run = (command: string): Effect.Effect<string, SandboxError> => {
    if (!config?.allowArbitraryCommands) {
      // Advisory warning — does not block execution.
      // Use defineCommand-based allow-lists for real isolation.
      // eslint-disable-next-line no-console
      console.warn(
        `[sandbox] run() executing shell command without defineCommand allow-list. ` +
        `Set allowArbitraryCommands:true to suppress this warning. ` +
        `Command: ${command}`
      );
    }
    return Effect.tryPromise({
      try: async () => {
        const result = await execAsync(command, {
          cwd,
          encoding: "utf-8",
          timeout,
          env: buildCommandEnv(config),
        });
        return result.stdout + result.stderr;
      },
      catch: (e) => {
        const err = e as { message?: string; code?: number };
        if (err.message?.includes("timeout")) {
          return SandboxError.Timeout(command, timeout);
        }
        return SandboxError.CommandFailed(command, err.message ?? String(e));
      },
    });
  };

  const writeFile = (filePath: string, content: string): Effect.Effect<void, SandboxError> => {
    const traversalErr = assertWithinCwd(filePath, cwd);
    if (traversalErr) return Effect.fail(traversalErr);
    const resolved = path.resolve(cwd, filePath);
    return Effect.tryPromise({
      try: async () => {
        const dir = path.dirname(resolved);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(resolved, content, "utf-8");
      },
      catch: (e) => {
        const err = e as { code?: string };
        if (err.code === "EACCES") return SandboxError.PermissionDenied(filePath);
        throw e;
      },
    });
  };

  const readFile = (filePath: string): Effect.Effect<string, SandboxError> => {
    const traversalErr = assertWithinCwd(filePath, cwd);
    if (traversalErr) return Effect.fail(traversalErr);
    const resolved = path.resolve(cwd, filePath);
    return Effect.tryPromise({
      try: async () => fs.promises.readFile(resolved, "utf-8"),
      catch: (e) => {
        const err = e as { code?: string };
        if (err.code === "ENOENT") return SandboxError.FileNotFound(filePath);
        if (err.code === "EACCES") return SandboxError.PermissionDenied(filePath);
        throw e;
      },
    });
  };

  const listDir = (filePath: string): Effect.Effect<string[], SandboxError> => {
    const traversalErr = assertWithinCwd(filePath, cwd);
    if (traversalErr) return Effect.fail(traversalErr);
    const resolved = path.resolve(cwd, filePath);
    return Effect.tryPromise({
      try: async () => fs.promises.readdir(resolved),
      catch: (e) => {
        const err = e as { code?: string };
        if (err.code === "ENOENT") return SandboxError.FileNotFound(filePath);
        if (err.code === "EACCES") return SandboxError.PermissionDenied(filePath);
        throw e;
      },
    });
  };

  // Fix #17: assertWithinCwd must be called before fs.promises.access so that
  // absolute paths that escape the sandbox cwd are rejected.
  const exists = (filePath: string): Effect.Effect<boolean, SandboxError> => {
    const traversalErr = assertWithinCwd(filePath, cwd);
    if (traversalErr) return Effect.fail(traversalErr);
    const resolved = path.resolve(cwd, filePath);
    return Effect.tryPromise(() => fs.promises.access(resolved)).pipe(
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false))
    );
  };

  return Effect.succeed({ run, writeFile, readFile, listDir, exists, cwd });
};

export const makeSandbox = (type: "memory" | "local", config?: SandboxConfig): Effect.Effect<Sandbox> =>
  type === "memory" ? makeInMemorySandbox(config) : makeLocalSandbox(config);