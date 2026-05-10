import { Effect } from "effect";
import { createHarnessRegistry } from "@gatesai/runtime";
import { makeAnthropicProvider } from "@gatesai/providers/anthropic";
import { makeLocalSandbox } from "@gatesai/sandbox";
import { makeBashTool, makeReadTool } from "@gatesai/runtime";

import plannerHarness from "./harnesses/planner.js";
import issueCreatorHarness from "./harnesses/issue-creator.js";

const program = Effect.gen(function* () {
  const provider = makeAnthropicProvider({ apiKey: process.env["ANTHROPIC_API_KEY"]! });
  const sandbox = yield* makeLocalSandbox({ isolated: true });

  // Built-in tools available to any agent session
  const tools = new Map([
    ["bash", makeBashTool(sandbox)],
    ["read", makeReadTool(sandbox)],
  ]);

  const config = {
    provider: {
      chat: (messages: unknown[], toolDefs?: unknown[]) =>
        provider.chat(messages as never, toolDefs as never),
    },
    tools,
    maxToolIterations: 15,
  };

  const registry = createHarnessRegistry();
  registry.register("planner", plannerHarness, config);
  registry.register("issue-creator", issueCreatorHarness, config);

  const env = {
    GITHUB_TOKEN: process.env["GITHUB_TOKEN"]!,
  };

  // Run the pipeline: transcript → issues
  const result = yield* registry.run("planner", {
    transcript: process.argv[2] ?? "discuss implementing dark mode — assigned to @ana",
    repo: process.argv[3] ?? "org/repo",
  }, env);

  console.log(JSON.stringify(result, null, 2));
});

Effect.runPromise(program).catch(console.error);
