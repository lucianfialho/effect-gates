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

    const resolvePath = (p: string): string => {
      if (p.startsWith("/")) return p;
      return `${cwd}/${p}`.replace(/\/+/g, "/");
    };

    const run = (_command: string): Effect.Effect<string, SandboxError> =>
      Effect.sync(() => {
        return "[SIMULATED] Command executed in memory sandbox";
      });

    const writeFile = (path: string, content: string): Effect.Effect<void, SandboxError> =>
      Effect.sync(() => {
        const resolved = resolvePath(path);
        files.set(resolved, content);
      });

    const readFile = (path: string): Effect.Effect<string, SandboxError> =>
      Effect.gen(function* () {
        const resolved = resolvePath(path);
        const content = files.get(resolved);
        if (content === undefined) {
          return yield* Effect.fail(SandboxError.FileNotFound(path));
        }
        return content;
      });

    const listDir = (path: string): Effect.Effect<string[], SandboxError> =>
      Effect.sync(() => {
        const resolved = resolvePath(path);
        const entries = new Set<string>();

        for (const filePath of files.keys()) {
          if (filePath.startsWith(resolved + "/") && filePath !== resolved) {
            const relative = filePath.substring(resolved.length + 1);
            const firstSlash = relative.indexOf("/");
            const entry = firstSlash === -1 ? relative : relative.substring(0, firstSlash);
            if (entry) entries.add(entry);
          }
        }

        return Array.from(entries).sort();
      });

    const exists = (path: string): Effect.Effect<boolean, SandboxError> =>
      Effect.sync(() => {
        const resolved = resolvePath(path);
        return files.has(resolved);
      });

    return { run, writeFile, readFile, listDir, exists, cwd };
  });

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

  const run = (command: string): Effect.Effect<string, SandboxError> =>
    Effect.tryPromise({
      try: async () => {
        const result = await execAsync(command, {
          cwd,
          encoding: "utf-8",
          timeout,
          env: { ...nodeProcess.env, ...config?.env },
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

  const exists = (filePath: string): Effect.Effect<boolean, SandboxError> =>
    Effect.tryPromise(() => fs.promises.access(filePath)).pipe(
      Effect.map(() => true),
      Effect.catchAll(() => Effect.succeed(false))
    );

  return Effect.succeed({ run, writeFile, readFile, listDir, exists, cwd });
};

export const makeSandbox = (type: "memory" | "local", config?: SandboxConfig): Effect.Effect<Sandbox> =>
  type === "memory" ? makeInMemorySandbox(config) : makeLocalSandbox(config);