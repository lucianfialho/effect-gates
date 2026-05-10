import { Effect } from "effect";
import {
  createHarnessRegistry,
  makeReadTool,
  makeGlobTool,
  makeGrepTool,
  makeBashTool,
} from "@gatesai/runtime";
import { makeAnthropicProvider } from "@gatesai/providers";
import { makeLocalSandbox } from "@gatesai/sandbox";
import codeReviewHarness from "../.gates/harnesses/code-review/harness.js";

const program = Effect.gen(function* () {
  const sandbox = yield* makeLocalSandbox({ cwd: process.cwd() });
  const provider = makeAnthropicProvider({
    apiKey: process.env["ANTHROPIC_API_KEY"]!,
    model: "claude-sonnet-4-6",
  });

  const tools = new Map([
    ["read",  makeReadTool(sandbox)],
    ["glob",  makeGlobTool(sandbox)],
    ["grep",  makeGrepTool(sandbox)],
    ["bash",  makeBashTool(sandbox)],
  ]);

  const registry = createHarnessRegistry({ provider, tools, maxToolIterations: 20 });
  registry.register("code-review", codeReviewHarness);

  console.log("◆ Running code-review harness (dryRun)\n");

  const result = yield* registry.run(
    "code-review",
    {
      path: "./packages/runtime/src",
      repo: "lucianfialho/gates-effect",
      focus: "error handling and type safety",
      maxIssues: 5,
      dryRun: true,
    },
    { GITHUB_TOKEN: "" }
  );

  return result;
});

Effect.runPromise(program)
  .then((r) => {
    console.log("\n◆ Result:\n");
    console.log(JSON.stringify(r, null, 2));
  })
  .catch((e) => {
    console.error("✗ Error:", e);
    process.exit(1);
  });
