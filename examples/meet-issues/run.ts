import { Effect } from "effect";
import { createHarnessRegistry, makeBashTool, makeReadTool } from "@gatesai/runtime";
import { makeAnthropicProvider } from "@gatesai/providers/anthropic";
import { makeLocalSandbox } from "@gatesai/sandbox";

import plannerHarness from "./harnesses/planner.js";
import issueCreatorHarness from "./harnesses/issue-creator.js";

const program = Effect.gen(function* () {
  const sandbox = yield* makeLocalSandbox({ isolated: true });
  const provider = makeAnthropicProvider({ apiKey: process.env["ANTHROPIC_API_KEY"]! });

  const tools = new Map([
    ["bash", makeBashTool(sandbox)],
    ["read", makeReadTool(sandbox)],
  ]);

  const config = {
    provider: { chat: provider.chat.bind(provider) },
    tools,
    maxToolIterations: 15,
  };

  const registry = createHarnessRegistry();
  registry.register("planner", plannerHarness, config);
  registry.register("issue-creator", issueCreatorHarness, config);

  const env = { GITHUB_TOKEN: process.env["GITHUB_TOKEN"]! };

  return yield* registry.run("planner", {
    transcript: process.argv[2] ?? "discuss implementing dark mode — assigned to @ana",
    repo: process.argv[3] ?? "org/repo",
  }, env);
});

Effect.runPromise(program)
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch(console.error);
