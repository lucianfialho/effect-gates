import { Effect } from "effect";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { defineHarness, defineCommand } from "@gatesai/runtime";

interface IssuePayload {
  issue: { title: string; body: string; labels?: string[] };
  repo: string;
}

/**
 * Creates a single GitHub issue via gh CLI.
 *
 * env.GITHUB_TOKEN is injected via defineCommand — the LLM never sees it.
 * Body written to a temp file to prevent shell injection from LLM-generated content.
 */
export default defineHarness<IssuePayload>(
  ({ payload, env }) =>
    Effect.gen(function* () {
      const { issue, repo } = payload;

      const gh = defineCommand({
        name: "gh",
        description: "GitHub CLI",
        executable: "gh",
        allowedSubcommands: ["issue"],
        env: { GH_TOKEN: env["GITHUB_TOKEN"] },
      });

      // Write body to temp file — prevents shell injection from LLM-generated body text
      const tmpFile = join(tmpdir(), `gh-issue-body-${Date.now()}.md`);
      yield* Effect.tryPromise({
        try: () => writeFile(tmpFile, issue.body, "utf-8"),
        catch: (e) => ({ code: "FILE_ERROR", message: String(e) }),
      });

      // Escape title (no body interpolation — it's in the file)
      // Labels omitted from CLI args to prevent injection; add via API if needed
      const title = issue.title.replace(/"/g, '\\"').replace(/\n/g, " ");

      const result = yield* gh.execute({
        args: `issue create --repo ${repo} --title "${title}" --body-file "${tmpFile}"`,
      });

      yield* Effect.tryPromise({ try: () => unlink(tmpFile), catch: () => null });

      const url = result.content.trim().split("\n").find((l) => l.startsWith("https://")) ?? "";
      return { created: !!url, url };
    })
);
