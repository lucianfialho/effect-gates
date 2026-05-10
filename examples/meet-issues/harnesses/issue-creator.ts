import { Effect } from "effect";
import { defineHarness, defineCommand } from "@gatesai/runtime";

interface IssuePayload {
  issue: { title: string; body: string; labels?: string[] };
  repo: string;
}

/**
 * Issue creator harness: creates a single GitHub issue via gh CLI.
 * GITHUB_TOKEN is injected via env (harness layer) — the LLM never sees it.
 */
export default defineHarness<IssuePayload>(
  ({ payload, env }) =>
    Effect.gen(function* () {
      const { issue, repo } = payload;

      // defineCommand isolates the env: only GH_TOKEN reaches the process,
      // never the full process.env
      const gh = defineCommand({
        name: "gh",
        description: "GitHub CLI",
        executable: "gh",
        allowedSubcommands: ["issue"],
        env: { GH_TOKEN: env["GITHUB_TOKEN"] },
      });

      const labelArgs = issue.labels?.length
        ? issue.labels.map((l) => `--label "${l}"`).join(" ")
        : "";

      const result = yield* gh.execute({
        args: `issue create --repo ${repo} --title "${issue.title}" --body "${issue.body}" ${labelArgs}`.trim(),
      });

      return { created: true, url: result.content.trim() };
    })
);
