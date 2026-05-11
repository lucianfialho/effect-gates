import { Effect } from "effect";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { defineHarness, defineCommand } from "@gatesai/runtime";

export const name = "Code Review";
export const description = "Investiga codebase e abre GitHub issues com melhorias encontradas";

// ── Prompts ───────────────────────────────────────────────────────────────────

const INVESTIGATOR_PROMPT = `You are a code reviewer. Be EFFICIENT — use at most 8 tool calls, then output findings.

STRATEGY:
1. bash: one command to list key source files (exclude node_modules, dist, .git)
2. read: 4-6 most important files (entry points, security-sensitive, core logic)
3. grep: one search for dangerous patterns if needed
4. OUTPUT JSON — stop exploring after 8 tool calls

FORMAT — output ONLY this JSON array, starting with [ immediately:
[{"title":"<max 80 chars>","body":"## Problem\\n...\\n\\n## Why\\n...\\n\\n## Fix\\n...","severity":"high"|"medium"|"low","labels":["bug"|"security"|"tech-debt"|"performance"|"test"],"file":"<path>","line":<number or null>,"snippet":"<2-3 code lines or null>"}]

RULES:
- After 8 tool calls: output findings immediately, do NOT continue exploring
- Start JSON with [ on the very first character — no prose before or after
- 3-5 findings maximum
- "Let me check one more thing" is WRONG — output JSON instead
- Find: bugs, security issues, unhandled errors, dangerous patterns`;



const PARAM_PARSER_PROMPT = `Extract code review parameters from the user's message.
Respond with ONLY a JSON object — no prose, no markdown fences.

{
  "path": "<directory to review, or '.' if not specified>",
  "repo": "<owner/repo — REQUIRED, ask if missing>",
  "focus": "<focus area or null>",
  "maxIssues": <number, default 5>,
  "dryRun": <true if user says 'dry run', 'sem criar', 'sem abrir', default false>
}

Examples:
"revisa ./packages/runtime no repo lucianfialho/effect-gates com foco em security"
→ {"path":"./packages/runtime","repo":"lucianfialho/effect-gates","focus":"security","maxIssues":5,"dryRun":false}

"code review src/ for lucianfialho/gates dry run"
→ {"path":"src/","repo":"lucianfialho/gates","focus":null,"maxIssues":5,"dryRun":true}`;

// ── Types ──────────────────────────────────────────────────────────────────────

interface Finding {
  title: string;
  body: string;
  severity: "low" | "medium" | "high";
  labels: string[];
  file: string | null;
  line?: number | null;
  snippet?: string | null;
}

interface ParsedParams {
  path: string;
  repo: string | null;
  focus: string | null;
  maxIssues: number;
  dryRun: boolean;
}

function parseFindings(content: string): Finding[] {
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown[];
    return parsed.filter((f): f is Finding =>
      typeof f === "object" && f !== null &&
      "title" in f && "body" in f && "severity" in f
    ).map((f) => ({
      ...f,
      line: (f as Finding).line ?? null,
      snippet: (f as Finding).snippet ?? null,
    }));
  } catch {
    return [];
  }
}

function extractJson<T>(content: string): T | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]) as T; } catch { return null; }
}

// ── Payload — accepts both TUI message and structured args ────────────────────

type Payload =
  | { message: string }                                           // from gates TUI
  | { path?: string; repo: string; focus?: string; maxIssues?: number; dryRun?: boolean }; // programmatic

// ── Harness ───────────────────────────────────────────────────────────────────

export default defineHarness<Payload>(
  ({ init, payload, env, onEvent }) =>
    Effect.gen(function* () {
      // ── Parse params from natural language message (TUI path) ────────────
      let params: ParsedParams;

      if ("message" in payload) {
        const parser = yield* init({ systemPrompt: PARAM_PARSER_PROMPT });
        const response = yield* parser.prompt(payload.message);
        const extracted = extractJson<ParsedParams>(response.content);

        if (!extracted?.repo) {
          return {
            message: "Missing repo. Try: 'revisa ./src no repo owner/repo'",
            usage: "code review <path> no repo <owner/repo> [com foco em <area>] [dry run]",
          };
        }

        params = {
          path: extracted.path ?? ".",
          repo: extracted.repo,
          focus: extracted.focus ?? null,
          maxIssues: extracted.maxIssues ?? 5,
          dryRun: extracted.dryRun ?? false,
        };
      } else {
        params = {
          path: payload.path ?? ".",
          repo: payload.repo,
          focus: payload.focus ?? null,
          maxIssues: payload.maxIssues ?? 5,
          dryRun: payload.dryRun ?? false,
        };
      }

      const { path, repo, focus, maxIssues, dryRun } = params;

      // ── Investigate ───────────────────────────────────────────────────────
      const session = yield* init({ systemPrompt: INVESTIGATOR_PROMPT, onEvent });

      const focusClause = focus ? ` Focus on: ${focus}.` : "";
      const investigationPrompt = `Review: ${path}${focusClause}
Tool call budget: 8 maximum. After 8 calls, output JSON immediately.
Output ${maxIssues} findings max as a JSON array starting with [.`;

      const response = yield* session.prompt(investigationPrompt);
      let rawContent = response.content;

      // If model didn't output JSON, use a separate formatter session (no tools)
      // so the model can't keep investigating — it can only format.
      if (!rawContent.trim().startsWith("[")) {
        const formatter = yield* init({
          // replaceTools: true → no tools in this session, model can only output text
          tools: new Map(),
          replaceTools: true,
          systemPrompt: `You are a JSON formatter. You receive code review notes and output ONLY a JSON array.
No prose. No markdown. Start with [ and end with ].
Each item: {"title":"<80 chars>","body":"## Problem\\n...\\n\\n## Why\\n...\\n\\n## Fix\\n...","severity":"low"|"medium"|"high","labels":["bug"|"enhancement"|"tech-debt"|"security"|"performance"|"test"],"file":"<path or null>"}`,
        });
        const formatted = yield* formatter.prompt(
          `Convert these code review notes to a JSON array of findings (max ${maxIssues}):\n\n${rawContent}`
        );
        rawContent = formatted.content;
      }

      const findings = parseFindings(rawContent);

      if (findings.length === 0) {
        return {
          message: "No findings parsed. Raw response:",
          raw: response.content.slice(0, 500),
          issues: [],
        };
      }

      // ── Emit kanban data to TUI before creating issues ────────────────────
      onEvent?.({
        type: "kanban_update",
        findings: findings.slice(0, maxIssues).map((f, i) => ({
          id: `finding-${i}`,
          title: f.title,
          body: f.body,
          severity: f.severity,
          labels: f.labels,
          file: f.file ?? null,
          line: f.line ?? null,
          snippet: f.snippet ?? null,
        })),
      });

      if (dryRun) {
        return {
          message: `[DRY RUN] Would create ${findings.length} issue(s) in ${repo}`,
          findings,
          issues: [],
        };
      }

      // ── Create GitHub issues ──────────────────────────────────────────────
      const gh = defineCommand({
        name: "gh",
        description: "GitHub CLI for creating issues",
        executable: "gh",
        allowedSubcommands: ["issue"],
        env: { GH_TOKEN: env["GITHUB_TOKEN"] ?? env["GH_TOKEN"] ?? "" },
      });

      const created: Array<{ title: string; url: string; severity: string }> = [];

      for (let i = 0; i < Math.min(findings.length, maxIssues); i++) {
        const finding = findings[i]!;
        const fileNote = finding.file ? `\n\n**File:** \`${finding.file}\`` : "";
        const meta = `\n\n---\n**Severity:** ${finding.severity}  \n**Labels:** ${finding.labels.join(", ") || "none"}`;
        const fullBody = finding.body + fileNote + meta;

        const tmpFile = join(tmpdir(), `gh-body-${Date.now()}-${i}.md`);
        yield* Effect.tryPromise({
          try: () => writeFile(tmpFile, fullBody, "utf-8"),
          catch: (e) => ({ code: "FILE_WRITE_ERROR", message: String(e) }),
        });

        const title = finding.title.replace(/"/g, '\\"');
        const result = yield* Effect.result(
          gh.execute({ args: `issue create --repo ${repo} --title "${title}" --body-file "${tmpFile}"` })
        );

        yield* Effect.tryPromise({ try: () => unlink(tmpFile), catch: () => null });

        if (result._tag === "Success") {
          const out = result.success.content.trim();
          const url = out.split("\n").find((l) => l.startsWith("https://")) ?? "";
          if (url) {
            created.push({ title: finding.title, url, severity: finding.severity });
          } else {
            console.error(`[gh] failed: ${out.slice(0, 200)}`);
          }
        }
      }

      return {
        message: `Created ${created.length}/${Math.min(findings.length, maxIssues)} issues in ${repo}`,
        issues: created,
      };
    })
);
