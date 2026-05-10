import { defineHarness } from "@gatesai/runtime";
import * as v from "valibot";

/**
 * Planner harness: reads a meeting transcript, extracts action items,
 * then hands each one to the 'issue-creator' harness.
 *
 * Shows multi-harness orchestration: ctx.harness('issue-creator', payload)
 */
export default defineHarness(async ({ init, payload, env, harness }) => {
  const { transcript } = payload as { transcript: string };

  const agent = await init({ model: "anthropic/claude-sonnet-4-6" });

  // Step 1: extract structured action items from the transcript
  const items = await agent.skill("extract-issues", {
    args: { transcript },
    result: {
      parse: (raw) => {
        const parsed = v.safeParse(
          v.array(v.object({
            title: v.string(),
            body: v.string(),
            labels: v.optional(v.array(v.string())),
          })),
          raw
        );
        if (!parsed.success) {
          return Effect.fail({ code: "PARSE_ERROR", message: "Invalid issues shape" });
        }
        return Effect.succeed(parsed.output);
      },
    },
  });

  // Step 2: spawn issue-creator harness for each item (sequential or parallel)
  const results = [];
  for (const item of items) {
    const result = await harness("issue-creator", {
      issue: item,
      repo: (payload as { repo: string }).repo,
    });
    results.push(result);
  }

  return results;
});

// TypeScript can't see Effect in scope — import it for the result schema
import { Effect } from "effect";
