import { Effect } from "effect";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import type { Skill, SkillInput, SkillOutput, SkillError } from "./index.js";

const execAsync = promisify(exec);

const toSkillError = (error: unknown): SkillError => {
  const e = error as { message?: string; code?: number };
  return {
    code: String(e.code ?? "UNKNOWN"),
    message: e.message ?? String(error),
  };
};

export const bashSkill: Skill = {
  name: "bash",
  description: "Execute a bash command safely",
  execute: (input: SkillInput): Effect.Effect<SkillOutput, SkillError> =>
    Effect.gen(function* () {
      const command = input.params["command"];
      if (!command) {
        return yield* Effect.fail({
          code: "MISSING_COMMAND",
          message: "No command provided",
        });
      }

      const result = yield* Effect.tryPromise({
        try: async () => {
          const { stdout, stderr } = await execAsync(command, {
            cwd: input.context.workingDirectory,
          });
          return { stdout, stderr };
        },
        catch: (error: unknown) => {
          throw toSkillError(error);
        },
      });

      return {
        result: result.stdout || result.stderr,
        metadata: { command },
      };
    }),
};

export const readSkill: Skill = {
  name: "read",
  description: "Read file contents",
  execute: (input: SkillInput): Effect.Effect<SkillOutput, SkillError> =>
    Effect.gen(function* () {
      const filePath = input.params["path"];
      if (!filePath) {
        return yield* Effect.fail({
          code: "MISSING_PATH",
          message: "No file path provided",
        });
      }

      const content = yield* Effect.tryPromise({
        try: () => fs.promises.readFile(filePath, "utf-8"),
        catch: (error: unknown) => ({
          code: "READ_ERROR",
          message: String(error),
        } satisfies SkillError),
      });

      return { result: content, metadata: { path: filePath } };
    }),
};

export const writeSkill: Skill = {
  name: "write",
  description: "Write content to a file",
  execute: (input: SkillInput): Effect.Effect<SkillOutput, SkillError> =>
    Effect.gen(function* () {
      const filePath = input.params["path"];
      const content = input.params["content"];

      if (!filePath || content === undefined) {
        return yield* Effect.fail({
          code: "MISSING_PARAMS",
          message: "Missing path or content",
        });
      }

      yield* Effect.tryPromise({
        try: async () => {
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          await fs.promises.writeFile(filePath, content, "utf-8");
        },
        catch: (error: unknown) => ({
          code: "WRITE_ERROR",
          message: String(error),
        } satisfies SkillError),
      });

      return {
        result: `Written to ${filePath}`,
        metadata: { path: filePath, bytes: String(content.length) },
      };
    }),
};

export const searchSkill: Skill = {
  name: "search",
  description: "Search for text in files",
  execute: (input: SkillInput): Effect.Effect<SkillOutput, SkillError> =>
    Effect.gen(function* () {
      const query = input.params["query"];
      const searchPath = input.params["path"] ?? input.context.workingDirectory;

      if (!query) {
        return yield* Effect.fail({
          code: "MISSING_QUERY",
          message: "No search query provided",
        });
      }

      const command = `grep -rn "${query}" "${searchPath}" 2>/dev/null | head -100`;

      const result = yield* Effect.tryPromise({
        try: async () => {
          const { stdout, stderr } = await execAsync(command, {
            cwd: input.context.workingDirectory,
          });
          return { stdout, stderr };
        },
        catch: (error: unknown) => {
          throw toSkillError(error);
        },
      });

      return {
        result: result.stdout || `No matches found for "${query}"`,
        metadata: { query, path: searchPath },
      };
    }),
};

export const allBuiltinSkills: Skill[] = [bashSkill, readSkill, writeSkill, searchSkill];