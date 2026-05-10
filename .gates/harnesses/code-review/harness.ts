import { Effect } from "effect";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { defineHarness, defineCommand } from "@gatesai/runtime";

export const name = "Code Review";
export const description = "Investiga codebase e abre GitHub issues com melhorias encontradas";

// ── System prompt do investigador ──────────────────────────────────────────────

const INVESTIGATOR_PROMPT = `You are a senior software engineer doing a systematic code review.

Use the available tools (read, glob, grep, bash) to explore the codebase:
1. glob to discover source files and structure
2. read key files (entry points, core modules, types)
3. grep for patterns (error handling, TODOs, repeated code)
4. bash for quick counts and stats

After investigation, output ONLY a JSON array of findings. No prose, no markdown fences.

Each finding must be:
{
  "title": "Concise issue title (max 80 chars)",
  "body": "## Problem\n...\n\n## Why it matters\n...\n\n## Suggested fix\n...",
  "severity": "low" | "medium" | "high",
  "labels": ["bug" | "enhancement" | "tech-debt" | "security" | "performance" | "test"],
  "file": "path/to/file.ts or null"
}

Focus on:
- Bugs and error handling gaps
- Performance bottlenecks
- Security issues (credential leaks, unvalidated input)
- Missing tests for critical paths
- Tech debt that slows the team
- Poor abstractions or duplication

Skip style preferences. Only concrete, actionable improvements.`;

// ── Types ──────────────────────────────────────────────────────────────────────

interface Finding {
  title: string;
  body: string;
  severity: "low" | "medium" | "high";
  labels: string[];
  file: string | null;
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

// ── Harness ───────────────────────────────────────────────────────────────────

export default defineHarness<{
  path?: string;
  repo: string;
  focus?: string;
  maxIssues?: number;
  dryRun?: boolean;
}>(
  ({ init, payload, env }) =>
    Effect.gen(function* () {
      const { path = ".", repo, focus, maxIssues = 5, dryRun = false } = payload;

      const session = yield* init({ systemPrompt: INVESTIGATOR_PROMPT });

      // Build investigation prompt
      const focusClause = focus ? `\n\nFocus particularly on: ${focus}` : "";
      const investigationPrompt = `Investigate the codebase at: ${path}

Start broad (glob for structure), then dive into key files.
Look for concrete improvements.${focusClause}

Output a JSON array of findings (max ${maxIssues} items).`;

      const response = yield* session.prompt(investigationPrompt);
      const findings = parseFindings(response.content);

      if (findings.length === 0) {
        return {
          message: "No findings parsed from investigation. Raw response saved.",
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

      // Create GitHub issues for each finding
      const gh = defineCommand({
        name: "gh",
        executable: "gh",
        allowedSubcommands: ["issue"],
        env: { GH_TOKEN: env["GITHUB_TOKEN"] ?? env["GH_TOKEN"] ?? "" },
      });

      const created: Array<{ title: string; url: string; severity: string }> = [];

      for (let i = 0; i < findings.slice(0, maxIssues).length; i++) {
        const finding = findings[i]!;
        const fileNote = finding.file ? `\n\n**File:** \`${finding.file}\`` : "";
        const meta = `\n\n---\n**Severity:** ${finding.severity}  \n**Labels:** ${finding.labels.join(", ") || "none"}`;
        const fullBody = finding.body + fileNote + meta;

        // Write body to temp file — avoids shell quoting issues with multiline text
        const tmpFile = join(tmpdir(), `gh-body-${Date.now()}-${i}.md`);
        yield* Effect.tryPromise({
          try: () => writeFile(tmpFile, fullBody, "utf-8"),
          catch: (e) => ({ code: "FILE_WRITE_ERROR", message: String(e) }),
        });

        const title = finding.title.replace(/"/g, '\\"');
        const result = yield* Effect.result(
          gh.execute({
            args: `issue create --repo ${repo} --title "${title}" --body-file "${tmpFile}"`,
          })
        );

        // Clean up temp file
        yield* Effect.tryPromise({ try: () => unlink(tmpFile), catch: () => null });

        if (result._tag === "Success") {
          const out = result.success.content.trim();
          const url = out.split("\n").find((l) => l.startsWith("https://")) ?? "";
          if (url) {
            created.push({ title: finding.title, url, severity: finding.severity });
          } else {
            console.error(`[gh] issue create failed: ${out.slice(0, 200)}`);
          }
        }
      }

      return {
        message: `Created ${created.length}/${Math.min(findings.length, maxIssues)} issues in ${repo}`,
        issues: created,
      };
    })
);
