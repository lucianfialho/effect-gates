import { Effect } from "effect";
import type { Tool } from "./tools.js";
import { toolResult, toolError } from "./tools.js";
import type { Sandbox } from "@gatesai/sandbox";

const spawnAsync = (cmd: string, args: string[], cwd?: string): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const { spawn } = await import("node:child_process");
      return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const proc = spawn(cmd, args, { cwd });
        proc.stdout.on("data", (d: Buffer) => chunks.push(d));
        proc.stderr.on("data", (d: Buffer) => chunks.push(d));
        proc.on("close", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        proc.on("error", reject);
      });
    },
    catch: (e) => new Error(`${cmd} failed: ${e instanceof Error ? e.message : String(e)}`),
  });

const handleSandboxError = (e: { message: string }) => toolError(e.message);

export const makeReadTool = (sandbox: Sandbox): Tool => ({
  name: "read",
  description: "Read file contents",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const p = params.path as string;
      if (!p) return toolError("Missing required parameter: path");

      const result = yield* Effect.result(sandbox.readFile(p));

      if (result._tag === "Failure") {
        return handleSandboxError(result.failure);
      }

      return toolResult(result.success, { path: p, size: result.success.length });
    }),
});

export const makeWriteTool = (sandbox: Sandbox): Tool => ({
  name: "write",
  description: "Write content to a file",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const p = params.path as string;
      const content = params.content as string;

      if (!p || content === undefined) {
        return toolError("Missing required parameters: path, content");
      }

      const result = yield* Effect.result(sandbox.writeFile(p, content));

      if (result._tag === "Failure") {
        return handleSandboxError(result.failure);
      }

      return toolResult(`Written ${content.length} bytes to ${p}`, { path: p });
    }),
});

export const makeBashTool = (sandbox: Sandbox): Tool => ({
  name: "bash",
  description: "Execute a bash command",
  parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const command = params.command as string;
      if (!command) return toolError("Missing required parameter: command");

      const result = yield* Effect.result(sandbox.run(command));

      if (result._tag === "Failure") {
        return handleSandboxError(result.failure);
      }

      return toolResult(result.success || "(empty output)", { command });
    }),
});

export const makeGlobTool = (sandbox: Sandbox): Tool => ({
  name: "glob",
  description: "Find files matching a pattern",
  parameters: { type: "object", properties: { pattern: { type: "string" }, cwd: { type: "string" } }, required: ["pattern"] },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const pattern = params.pattern as string;
      if (!pattern) return toolError("Missing required parameter: pattern");

      const cwd = (params.cwd as string) || sandbox.cwd;
      const result = yield* Effect.result(
        spawnAsync("find", [cwd, "-name", pattern, "-type", "f"])
      );

      if (result._tag === "Failure") {
        return toolError(result.failure.message);
      }

      const files = result.success.trim().split("\n").filter(Boolean).slice(0, 50);
      return toolResult(
        files.length > 0 ? files.join("\n") : "No matches found",
        { pattern, cwd, count: files.length }
      );
    }),
});

export const makeGrepTool = (sandbox: Sandbox): Tool => ({
  name: "grep",
  description: "Search for text in files",
  parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, caseSensitive: { type: "boolean" } }, required: ["query"] },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const query = params.query as string;
      if (!query) return toolError("Missing required parameter: query");

      const searchPath = (params.path as string) || sandbox.cwd;
      const caseSensitive = params.caseSensitive !== false;

      const grepArgs = caseSensitive ? ["-rn", query, searchPath] : ["-rni", query, searchPath];
      const result = yield* Effect.result(spawnAsync("grep", grepArgs));

      if (result._tag === "Failure") {
        return toolError(result.failure.message);
      }

      const lines = result.success.trim().split("\n").filter(Boolean).slice(0, 100);
      return toolResult(
        lines.length > 0 ? lines.join("\n") : `No matches found for "${query}"`,
        { query, path: searchPath, count: lines.length }
      );
    }),
});

export const makeEditTool = (sandbox: Sandbox): Tool => ({
  name: "edit",
  description: "Edit a file by replacing text",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit" },
      oldText: { type: "string", description: "Text to find and replace" },
      newText: { type: "string", description: "Replacement text" },
      replaceAll: { type: "boolean", description: "Replace all occurrences", default: false },
    },
    required: ["path", "oldText", "newText"]
  },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const path = params.path as string;
      const oldText = params.oldText as string;
      const newText = params.newText as string;
      const replaceAll = (params.replaceAll as boolean) ?? false;

      if (!path || !oldText) {
        return toolError("Missing required parameters: path, oldText");
      }

      const readResult = yield* Effect.result(sandbox.readFile(path));
      if (readResult._tag === "Failure") {
        return handleSandboxError(readResult.failure);
      }

      const content = readResult.success;
      let newContent: string;
      let count: number;

      if (replaceAll) {
        const regex = new RegExp(escapeRegex(oldText), "g");
        const matches = content.match(regex);
        count = matches?.length ?? 0;
        newContent = content.replace(regex, newText);
      } else {
        const idx = content.indexOf(oldText);
        if (idx === -1) {
          return toolError(`Text "${oldText.substring(0, 50)}..." not found in file`);
        }
        count = 1;
        newContent = content.substring(0, idx) + newText + content.substring(idx + oldText.length);
      }

      const writeResult = yield* Effect.result(sandbox.writeFile(path, newContent));
      if (writeResult._tag === "Failure") {
        return handleSandboxError(writeResult.failure);
      }

      return toolResult(`Edited ${count} occurrence(s) in ${path}`, { path, count, replaced: count > 0 });
    }),
});

const escapeRegex = (str: string): string =>
  str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const listTools = (sandbox: Sandbox): Tool[] => [
  makeReadTool(sandbox),
  makeWriteTool(sandbox),
  makeBashTool(sandbox),
  makeGlobTool(sandbox),
  makeGrepTool(sandbox),
  makeEditTool(sandbox),
];

export const toolsMap = (sandbox: Sandbox): Map<string, Tool> =>
  new Map(listTools(sandbox).map((t) => [t.name, t]));