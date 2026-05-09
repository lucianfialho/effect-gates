import { Effect } from "effect";
import type { Tool } from "./tools.js";
import { toolResult, toolError } from "./tools.js";
import type { Sandbox } from "@gates-effect/sandbox";

export interface PatchResult {
  readonly applied: number;
  readonly failed: number;
  readonly output: string;
}

// ── Unified diff parser ───────────────────────────────────────────────────────

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of patch.split("\n")) {
    const hunkHeader = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkHeader) {
      if (current) hunks.push(current);
      current = {
        oldStart: parseInt(hunkHeader[1]!),
        oldCount: parseInt(hunkHeader[2] ?? "1"),
        newStart: parseInt(hunkHeader[3]!),
        newCount: parseInt(hunkHeader[4] ?? "1"),
        lines: [],
      };
      continue;
    }
    if (current && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

// ── Apply a single hunk with fuzzy offset search ─────────────────────────────

function applyHunk(lines: string[], hunk: Hunk, offset: number): { lines: string[]; offset: number } | null {
  const contextLines = hunk.lines.filter((l) => l.startsWith(" ")).map((l) => l.slice(1));
  const removeLines = hunk.lines.filter((l) => l.startsWith("-")).map((l) => l.slice(1));

  // Find the anchor position (where context + removes start)
  const anchorPattern = [
    ...hunk.lines
      .filter((l) => l.startsWith(" ") || l.startsWith("-"))
      .map((l) => l.slice(1)),
  ];

  let startIdx = hunk.oldStart - 1 + offset;

  // Try exact position first, then fuzzy search ±10 lines
  for (let delta = 0; delta <= 10; delta++) {
    for (const sign of [0, -delta, delta]) {
      if (sign === 0 && delta > 0) continue;
      const tryIdx = startIdx + sign;
      if (tryIdx < 0 || tryIdx + anchorPattern.length > lines.length) continue;

      const slice = lines.slice(tryIdx, tryIdx + anchorPattern.length);
      if (slice.every((l, i) => l === anchorPattern[i])) {
        // Found the anchor — apply the hunk
        const newLines = [...lines];
        const addLines = hunk.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
        const removeCount = removeLines.length;

        newLines.splice(tryIdx, anchorPattern.length, ...hunk.lines
          .filter((l) => l.startsWith(" ") || l.startsWith("+"))
          .map((l) => l.slice(1)));

        const newOffset = offset + (addLines.length - removeCount);
        return { lines: newLines, offset: newOffset };
      }
    }
  }

  return null; // hunk failed to apply
}

// ── Core applyPatch function ──────────────────────────────────────────────────

export const applyPatch = (
  originalContent: string,
  patch: string
): { success: boolean; content: string; failed: number } => {
  const hunks = parseHunks(patch);
  if (hunks.length === 0) {
    return { success: false, content: originalContent, failed: 0 };
  }

  let lines = originalContent.split("\n");
  let offset = 0;
  let failed = 0;

  for (const hunk of hunks) {
    const result = applyHunk(lines, hunk, offset);
    if (result) {
      lines = result.lines;
      offset = result.offset;
    } else {
      failed++;
    }
  }

  return {
    success: failed === 0,
    content: lines.join("\n"),
    failed,
  };
};

// ── Tool factory ──────────────────────────────────────────────────────────────

/**
 * Creates a tool that applies a unified diff patch to a file.
 * Safer than makeEditTool for complex multi-location changes — handles
 * context lines and fuzzy offset matching when line numbers drift.
 *
 * @example
 * // LLM provides:
 * // --- a/src/auth.ts
 * // +++ b/src/auth.ts
 * // @@ -10,7 +10,7 @@
 * //  function login(user: string) {
 * // -  return token;
 * // +  return createToken(user);
 * //  }
 */
export const makePatchTool = (sandbox: Sandbox): Tool => ({
  name: "patch",
  description: "Apply a unified diff patch to a file. Use this for complex multi-location edits that involve context lines.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to patch" },
      patch: { type: "string", description: "Unified diff patch (--- +++ @@ format)" },
    },
    required: ["path", "patch"],
  },
  execute: (params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const path = params.path as string;
      const patchStr = params.patch as string;
      if (!path || !patchStr) return toolError("Missing required parameters: path, patch");

      const readResult = yield* Effect.result(sandbox.readFile(path));
      if (readResult._tag === "Failure") {
        return toolError(readResult.failure.message);
      }

      const { success, content, failed } = applyPatch(readResult.success, patchStr);

      if (failed > 0 && !success) {
        return toolError(`Patch failed: ${failed} hunk(s) could not be applied. Check line numbers and context.`);
      }

      const writeResult = yield* Effect.result(sandbox.writeFile(path, content));
      if (writeResult._tag === "Failure") {
        return toolError(writeResult.failure.message);
      }

      const hunksApplied = parseHunks(patchStr).length - failed;
      return toolResult(
        `Patched ${path} — ${hunksApplied} hunk(s) applied${failed > 0 ? `, ${failed} failed` : ""}`,
        { path, hunksApplied, failed }
      );
    }),
});
