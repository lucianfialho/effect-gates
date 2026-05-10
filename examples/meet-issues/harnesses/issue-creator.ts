import { Effect } from "effect";
import { defineHarness, defineCommand } from "@gatesai/runtime";

interface IssuePayload {
  issue: { title: string; body: string; labels?: string[] };
  repo: string;
}

/**
 * Creates a single GitHub issue via gh CLI.
 *
 * env.GITHUB_TOKEN is injected via defineCommand — the LLM never sees it.
 * No init() needed: this harness talks directly to the tool, no LLM involved.
 */
export default defineHarness<IssuePayload>(
  ({ payload, env }) =>
    Effect.gen(function* () {
      const { issue, repo } = payload;

      // GH_TOKEN injected here — not in process.env, not visible to any agent
      const gh = defineCommand({
        name: "gh",
        description: "GitHub CLI",
        executable: "gh",
        allowedSubcommands: ["issue"],
        env: { GH_TOKEN: env["GITHUB_TOKEN"] },
      });

      const labels = issue.labels?.map((l) => `--label "${l}"`).join(" ") ?? "";

      const result = yield* gh.execute({
        args: `issue create --repo ${repo} --title "${issue.title}" --body "${issue.body}" ${labels}`.trim(),
      });

      return { created: true, url: result.content.trim() };
    })
);
