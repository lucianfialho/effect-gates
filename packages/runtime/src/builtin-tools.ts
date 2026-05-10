import { Effect } from "effect";
import type { Tool } from "./tools.js";
import { toolResult, toolError } from "./tools.js";
import type { Sandbox } from "@gatesai/sandbox";

// ── Constants (mirroring Flue's limits) ────────────────────────────────────

const MAX_READ_LINES     = 200;   // lines per page
const MAX_BASH_LINES     = 200;   // tail lines shown when output is large
const MAX_GREP_MATCHES   = 100;
const MAX_GREP_LINE_LEN  = 300;
const MAX_GLOB_RESULTS   = 500;

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── read — paginated ─────────────────────────────────────────────────────────

export const makeReadTool = (sandbox: Sandbox): Tool => ({
  name: "read",
  description: `Read file contents. Paginates large files — use offset/limit to navigate.
Max ${MAX_READ_LINES} lines per call. If more lines exist, a continuation hint is shown.`,
  parameters: {
    type: "object",
    properties: {
      path:   { type: "string", description: "File path to read" },
      offset: { type: "number", description: `Start line (0-based). Default: 0` },
      limit:  { type: "number", description: `Max lines to return. Default: ${MAX_READ_LINES}` },
    },
    required: ["path"],
  },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const p = params["path"] as string;
      if (!p) return toolError("Missing required parameter: path");

      const offset = Math.max(0, (params["offset"] as number | undefined) ?? 0);
      const limit  = Math.min(
        Math.max(1, (params["limit"] as number | undefined) ?? MAX_READ_LINES),
        MAX_READ_LINES * 2  // hard cap: never more than 2x default regardless of param
      );

      const result = yield* Effect.result(sandbox.readFile(p));
      if (result._tag === "Failure") return handleSandboxError(result.failure);

      const lines = result.success.split("\n");
      const total = lines.length;
      const start = Math.min(offset, total);
      const end   = Math.min(start + limit, total);
      const slice = lines.slice(start, end).join("\n");

      const pagination = end < total
        ? `\n\n[Lines ${start + 1}–${end} of ${total}. Use offset=${end} to read more.]`
        : total > MAX_READ_LINES
          ? `\n\n[End of file. ${total} total lines.]`
          : "";

      return toolResult(slice + pagination, { path: p, lines: end - start, total, offset: start });
    }),
});

// ── write ─────────────────────────────────────────────────────────────────────

export const makeWriteTool = (sandbox: Sandbox): Tool => ({
  name: "write",
  description: "Write content to a file",
  parameters: {
    type: "object",
    properties: {
      path:    { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const p = params["path"] as string;
      const content = params["content"] as string;
      if (!p || content === undefined) return toolError("Missing required parameters: path, content");

      const result = yield* Effect.result(sandbox.writeFile(p, content));
      if (result._tag === "Failure") return handleSandboxError(result.failure);

      return toolResult(`Written ${content.length} bytes to ${p}`, { path: p });
    }),
});

// ── bash — tail-truncated ─────────────────────────────────────────────────────

export const makeBashTool = (sandbox: Sandbox): Tool => ({
  name: "bash",
  description: `Execute a bash command. Output capped at ${MAX_BASH_LINES} lines (tail shown if truncated).`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd:     { type: "string" },
    },
    required: ["command"],
  },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const command = params["command"] as string;
      if (!command) return toolError("Missing required parameter: command");

      const result = yield* Effect.result(sandbox.run(command));
      if (result._tag === "Failure") return handleSandboxError(result.failure);

      const raw = result.success || "(empty output)";
      const lines = raw.split("\n");

      if (lines.length <= MAX_BASH_LINES) {
        return toolResult(raw, { command });
      }

      const tail = lines.slice(-MAX_BASH_LINES).join("\n");
      const header = `[Output truncated — showing last ${MAX_BASH_LINES} of ${lines.length} lines]\n`;
      return toolResult(header + tail, { command, truncated: true, totalLines: lines.length });
    }),
});

// ── glob ──────────────────────────────────────────────────────────────────────

export const makeGlobTool = (sandbox: Sandbox): Tool => ({
  name: "glob",
  description: `Find files matching a pattern. Returns up to ${MAX_GLOB_RESULTS} results.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      cwd:     { type: "string" },
    },
    required: ["pattern"],
  },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const pattern = params["pattern"] as string;
      if (!pattern) return toolError("Missing required parameter: pattern");

      const cwd = (params["cwd"] as string) || sandbox.cwd;
      const result = yield* Effect.result(
        spawnAsync("find", [cwd, "-name", pattern, "-type", "f"])
      );

      if (result._tag === "Failure") return toolError(result.failure.message);

      const files = result.success.trim().split("\n").filter(Boolean);
      const shown = files.slice(0, MAX_GLOB_RESULTS);
      const suffix = files.length > MAX_GLOB_RESULTS
        ? `\n[${files.length - MAX_GLOB_RESULTS} more results not shown]`
        : "";

      return toolResult(
        shown.length > 0 ? shown.join("\n") + suffix : "No matches found",
        { pattern, cwd, count: shown.length, total: files.length }
      );
    }),
});

// ── grep — line-length limited ────────────────────────────────────────────────

export const makeGrepTool = (sandbox: Sandbox): Tool => ({
  name: "grep",
  description: `Search for text in files. Returns up to ${MAX_GREP_MATCHES} matches, ${MAX_GREP_LINE_LEN} chars per line.`,
  parameters: {
    type: "object",
    properties: {
      query:         { type: "string" },
      path:          { type: "string" },
      caseSensitive: { type: "boolean" },
    },
    required: ["query"],
  },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const query = params["query"] as string;
      if (!query) return toolError("Missing required parameter: query");

      const searchPath = (params["path"] as string) || sandbox.cwd;
      const caseSensitive = params["caseSensitive"] !== false;
      const grepArgs = caseSensitive ? ["-rn", query, searchPath] : ["-rni", query, searchPath];

      const result = yield* Effect.result(spawnAsync("grep", grepArgs));
      if (result._tag === "Failure") return toolError(result.failure.message);

      const lines = result.success.trim().split("\n").filter(Boolean);
      const total = lines.length;
      const shown = lines
        .slice(0, MAX_GREP_MATCHES)
        .map(l => l.length > MAX_GREP_LINE_LEN ? l.slice(0, MAX_GREP_LINE_LEN) + "…" : l);

      const suffix = total > MAX_GREP_MATCHES
        ? `\n[${total - MAX_GREP_MATCHES} more matches not shown]`
        : "";

      return toolResult(
        shown.length > 0 ? shown.join("\n") + suffix : `No matches found for "${query}"`,
        { query, path: searchPath, shown: shown.length, total }
      );
    }),
});

// ── edit ──────────────────────────────────────────────────────────────────────

export const makeEditTool = (sandbox: Sandbox): Tool => ({
  name: "edit",
  description: "Edit a file by replacing text",
  parameters: {
    type: "object",
    properties: {
      path:       { type: "string", description: "File to edit" },
      oldText:    { type: "string", description: "Text to find and replace" },
      newText:    { type: "string", description: "Replacement text" },
      replaceAll: { type: "boolean", description: "Replace all occurrences", default: false },
    },
    required: ["path", "oldText", "newText"],
  },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const path       = params["path"] as string;
      const oldText    = params["oldText"] as string;
      const newText    = params["newText"] as string;
      const replaceAll = (params["replaceAll"] as boolean) ?? false;

      if (!path || !oldText) return toolError("Missing required parameters: path, oldText");

      const readResult = yield* Effect.result(sandbox.readFile(path));
      if (readResult._tag === "Failure") return handleSandboxError(readResult.failure);

      const content = readResult.success;
      let newContent: string;
      let count: number;

      if (replaceAll) {
        const regex = new RegExp(escapeRegex(oldText), "g");
        count = content.match(regex)?.length ?? 0;
        newContent = content.replace(regex, newText);
      } else {
        const idx = content.indexOf(oldText);
        if (idx === -1) return toolError(`Text not found in file: "${oldText.substring(0, 50)}"`);
        count = 1;
        newContent = content.substring(0, idx) + newText + content.substring(idx + oldText.length);
      }

      const writeResult = yield* Effect.result(sandbox.writeFile(path, newContent));
      if (writeResult._tag === "Failure") return handleSandboxError(writeResult.failure);

      return toolResult(`Edited ${count} occurrence(s) in ${path}`, { path, count });
    }),
});

const escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
