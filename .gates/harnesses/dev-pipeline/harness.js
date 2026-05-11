import { Effect } from "effect";
import { defineHarness } from "@gatesai/runtime";
export const name = "Dev Pipeline";
export const description = "Orquestra implementação iterativa usando gates CLI";
// ── Prompts ────────────────────────────────────────────────────────────────────
const PIPELINE_PROMPT = `You are a dev pipeline orchestrator. Your job is to execute implementation tasks one by one using the gates CLI, checking builds after each task, and committing when the build passes.

WORKFLOW for each task:
1. Run: gates run "<task>" --tools --max-iterations 30
2. Check build: cd <workDir> && npx tsc --noEmit 2>&1 | head -20
3. Run tests if available: pnpm test 2>&1 | tail -5
4. Check diff: git diff --stat HEAD
5. If build passes: git add -A && git commit -m "<commitPrefix>: <task summary>"
6. If build fails: run gates run "fix: <error output>" --tools --max-iterations 15, then re-check build
7. Report final status for the task (ok/fail)

RULES:
- Always run tasks in order
- Do not skip a task even if a previous one had issues
- After fixing a build failure, re-run tsc to confirm the fix worked
- Keep commit messages concise (under 72 chars)
- Use dryRun=true to skip actual commits (just report what would happen)
- Emit a summary table at the end: task | status | files changed | build`;
// ── Harness ───────────────────────────────────────────────────────────────────
export default defineHarness(({ init, payload, onEvent }) => Effect.gen(function* () {
    const { tasks, workDir, commitPrefix = "feat", dryRun = false, } = payload;
    if (!tasks || tasks.length === 0) {
        return { message: "No tasks provided.", results: [] };
    }
    const session = yield* init({ systemPrompt: PIPELINE_PROMPT, onEvent });
    const orchestrationPrompt = `
Execute the following ${tasks.length} implementation task(s) in order.

Working directory: ${workDir}
Commit prefix: ${commitPrefix}
Dry run: ${dryRun}

Tasks:
${tasks.map((t, i) => `${i + 1}. ${t}`).join("\n")}

For each task:
1. Run: gates run "${"{task}"}" --tools --max-iterations 30
2. Check build: cd ${workDir} && npx tsc --noEmit 2>&1 | head -20
3. Run tests if pnpm test exists
4. git diff --stat HEAD
5. ${dryRun ? "[DRY RUN] Do NOT commit — just report what would be committed" : `git add -A && git commit -m "${commitPrefix}: <summary>"`}
6. If build fails: gates run "fix: <error>" --tools --max-iterations 15, re-check

Report results as a table: task | status | files changed | build
`.trim();
    const response = yield* session.prompt(orchestrationPrompt);
    return {
        message: `Pipeline completed for ${tasks.length} task(s)`,
        summary: response.content,
        dryRun,
    };
}));
