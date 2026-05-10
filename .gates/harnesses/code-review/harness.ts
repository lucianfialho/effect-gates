import { Effect } from "effect";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { defineHarness, defineCommand } from "@gatesai/runtime";

export const name = "Code Review";
export const description = "Investiga codebase e abre GitHub issues com melhorias encontradas";

// ── Prompts ───────────────────────────────────────────────────────────────────

const INVESTIGATOR_PROMPT = `You are a code reviewer. Explore the codebase with tools, then output findings as JSON.

TOOLS TO USE:
- glob: find source files
- read: read file contents (use offset= to paginate large files)
- grep: search for patterns
- bash: run quick commands (wc -l, grep -c, etc.)

AFTER EXPLORING, output ONLY a JSON array. No text before or after. No markdown fences.

FORMAT (each item):
{"title":"<max 80 chars>","body":"## Problem\\n<what>\\n\\n## Why\\n<impact>\\n\\n## Fix\\n<how>","severity":"low"|"medium"|"high","labels":["bug"|"enhancement"|"tech-debt"|"security"|"performance"|"test"],"file":"<path or null>"}

VALID LAST MESSAGE:
[{"title":"...","body":"...","severity":"high","labels":["bug"],"file":"src/foo.ts"}]

INVALID LAST MESSAGE (do NOT do this):
"Let me check one more thing..."
"Here are my findings:"
Any prose or explanation.

WHAT TO FIND: bugs, error handling gaps, security issues, missing tests, tech debt, performance problems.
SKIP: style preferences, naming conventions, formatting.`;


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
    );
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

      const focusClause = focus ? `\nFocus: ${focus}` : "";
      const investigationPrompt = `Investigate: ${path}${focusClause}

Steps: glob files → read key files → grep patterns → form findings.

IMPORTANT: Your final message must be ONLY a JSON array, nothing else:
[{"title":"...","body":"...","severity":"high"|"medium"|"low","labels":[...],"file":"..."}]
Max ${maxIssues} items. Start with [ and end with ]. No other text.`;

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
