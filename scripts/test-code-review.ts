import { Effect } from "effect";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

function readApiKey(): string {
  // 1. env var
  if (process.env["ANTHROPIC_API_KEY"]) return process.env["ANTHROPIC_API_KEY"];
  // 2. ~/.gates/config.json
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".gates", "config.json"), "utf-8")) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    const key = config.providers?.["anthropic"]?.apiKey;
    if (key) return key;
  } catch { /* ignore */ }
  throw new Error("No ANTHROPIC_API_KEY found. Set env var or run: gates login --provider anthropic --key YOUR_KEY");
}

const program = Effect.gen(function* () {
  const sandbox = yield* makeLocalSandbox({ cwd: process.cwd() });
  const provider = makeAnthropicProvider({
    apiKey: readApiKey(),
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
      repo: "lucianfialho/effect-gates",
      focus: "error handling and type safety",
      maxIssues: 5,
      dryRun: false,
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
