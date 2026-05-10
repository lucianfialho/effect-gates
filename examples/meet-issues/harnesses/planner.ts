import { Effect } from "effect";
import { defineHarness } from "@gatesai/runtime";
import * as v from "valibot";

const IssueSchema = v.array(v.object({
  title: v.string(),
  body: v.string(),
  labels: v.optional(v.array(v.string())),
}));

/**
 * Planner harness: reads a meeting transcript, extracts action items,
 * then spawns an 'issue-creator' sub-harness for each one.
 */
export default defineHarness<{ transcript: string; repo: string }>(
  ({ init, payload, harness }) =>
    Effect.gen(function* () {
      const session = yield* init({ role: "planner" });

      // Extract structured issues from transcript
      const items = yield* session.skill("extract-issues", {
        args: { transcript: payload.transcript },
        result: {
          parse: (raw) => {
            const parsed = v.safeParse(IssueSchema, raw);
            return parsed.success
              ? Effect.succeed(parsed.output)
              : Effect.fail({ code: "PARSE_ERROR", message: v.flatten(parsed.issues).root?.join(", ") ?? "invalid shape" });
          },
        },
      });

      // Spawn issue-creator for each item — sequential
      return yield* Effect.all(
        items.map((issue) =>
          harness("issue-creator", { issue, repo: payload.repo })
        ),
      );
    })
);
