import { Effect } from "effect";
import { createHarnessRegistry } from "@gatesai/runtime";
import { makeAnthropicProvider } from "@gatesai/providers";
import { loadConnectors } from "@gatesai/skills";

import plannerHarness from "./harnesses/planner.js";
import issueCreatorHarness from "./harnesses/issue-creator.js";

const program = Effect.gen(function* () {
  // Load connector tools + docs from .gates/connectors/
  // (gws, gh and any other connectors you have installed)
  const connectors = yield* loadConnectors(".gates/connectors");

  const registry = createHarnessRegistry({
    provider: makeAnthropicProvider({ apiKey: process.env["ANTHROPIC_API_KEY"]! }),
    tools: connectors.allTools(),
    systemPromptSuffix: connectors.allDocs(),  // gws-guide.md, github-guide.md injected here
  });

  registry.register("planner", plannerHarness);
  registry.register("issue-creator", issueCreatorHarness);

  return yield* registry.run(
    "planner",
    {
      transcript: process.argv[2] ?? "discuss implementing dark mode — assigned to @ana",
      repo: process.argv[3] ?? "org/repo",
    },
    { GITHUB_TOKEN: process.env["GITHUB_TOKEN"]! }
  );
});

Effect.runPromise(program)
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch(console.error);
