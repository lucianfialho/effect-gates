import { defineHarness } from "@gatesai/runtime";
import { defineCommand } from "@gatesai/runtime";
import { Effect } from "effect";

/**
 * Issue creator harness: receives a single issue (title + body) and creates
 * it on GitHub via `gh` CLI.
 *
 * Shows credential isolation: GITHUB_TOKEN lives in env (harness layer),
 * never exposed to the LLM agent itself.
 */
export default defineHarness(async ({ payload, env }) => {
  const { issue, repo } = payload as {
    issue: { title: string; body: string; labels?: string[] };
    repo: string;
  };

  // defineCommand: GITHUB_TOKEN injected into isolated env, never leaked to LLM
  const gh = defineCommand({
    name: "gh",
    description: "GitHub CLI",
    executable: "gh",
    allowedSubcommands: ["issue", "pr"],
    env: { GH_TOKEN: env["GITHUB_TOKEN"] },
  });

  const labelArgs = issue.labels?.length
    ? issue.labels.map((l) => `--label "${l}"`).join(" ")
    : "";

  const output = await Effect.runPromise(
    gh.execute({
      args: `issue create --repo ${repo} --title "${issue.title}" --body "${issue.body}" ${labelArgs}`.trim(),
    })
  );

  return { created: true, url: output.content.trim() };
});
