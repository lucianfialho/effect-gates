/**
 * run-opentui-migration — triggers the dev-pipeline harness with the 6-phase
 * OpenTUI migration plan for /home/lucian/gates.
 *
 * Usage:
 *   npx tsx scripts/run-opentui-migration.ts [--dry-run]
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Effect } from "effect";
import {
  createHarnessRegistry,
  makeBashTool,
  makeReadTool,
  makeWriteTool,
  makeGlobTool,
  makeGrepTool,
  makeEditTool,
} from "@gatesai/runtime";
import { makeClaudeCodeProvider } from "@gatesai/providers";
import { makeLocalSandbox } from "@gatesai/sandbox";
import devPipelineHarness from "../.gates/harnesses/dev-pipeline/harness.js";

// ── Config ────────────────────────────────────────────────────────────────────

const GATES_DIR = "/home/lucian/gates";
const DRY_RUN = process.argv.includes("--dry-run");

// ── Migration tasks (6 phases) ────────────────────────────────────────────────

const MIGRATION_TASKS: string[] = [
  // Phase 1a — dependency swap
  "Install @opentui/core via bun add in /home/lucian/gates, update package.json scripts to use bun, remove ink and react deps, add bun-types",

  // Phase 1b — shared primitives
  "Create src/ui/tui/shared/colors.ts, types.ts, sse.ts — copy types from existing files, no React imports",

  // Phase 2 — router / screen state machine
  "Create src/ui/tui/router.ts — screen state machine class using @opentui/core BoxRenderable, replace app.tsx",

  // Phase 3 — screens
  "Port src/ui/tui/screens/chat.ts, harness-selector.ts, session-list.ts from React/Ink to @opentui/core BoxRenderable with keyboard handling",

  // Phase 4 — sidebar components
  "Port src/ui/tui/components/sidebar.ts, kanban.ts, tool-call-panel.ts from React/Ink to @opentui/core using TextRenderable and BoxRenderable",

  // Phase 5 — entry point + integration
  "Update src/ui/tui/index.ts entry point to use new router, remove all React/Ink imports, wire up @opentui/core App, verify bun run start:tui works",
];

// ── Runner ────────────────────────────────────────────────────────────────────

function readApiKey(): string {
  if (process.env["ANTHROPIC_API_KEY"]) return process.env["ANTHROPIC_API_KEY"];
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".gates", "config.json"), "utf-8")
    ) as { providers?: Record<string, { apiKey?: string }> };
    const key = config.providers?.["anthropic"]?.apiKey;
    if (key) return key;
  } catch {
    /* ignore */
  }
  throw new Error("No ANTHROPIC_API_KEY found in env or ~/.gates/config.json");
}

const program = Effect.gen(function* () {
  const sandbox = yield* makeLocalSandbox({ cwd: GATES_DIR });

  const provider = makeClaudeCodeProvider({
    model: "claude-sonnet-4-6",
    allowedTools: ["Bash", "Read", "Write", "Glob", "Grep", "Edit"],
    cwd: GATES_DIR,
  });

  const tools = new Map([
    ["bash",  makeBashTool(sandbox)],
    ["read",  makeReadTool(sandbox)],
    ["write", makeWriteTool(sandbox)],
    ["glob",  makeGlobTool(sandbox)],
    ["grep",  makeGrepTool(sandbox)],
    ["edit",  makeEditTool(sandbox)],
  ]);

  const registry = createHarnessRegistry({ provider, tools, maxToolIterations: 30 });
  registry.register("dev-pipeline", devPipelineHarness);

  console.log(`OpenTUI Migration Pipeline`);
  console.log(`  workDir: ${GATES_DIR}`);
  console.log(`  tasks:   ${MIGRATION_TASKS.length}`);
  console.log(`  dryRun:  ${DRY_RUN}`);
  console.log(`\nStarting...\n`);

  return yield* registry.run(
    "dev-pipeline",
    {
      tasks: MIGRATION_TASKS,
      workDir: GATES_DIR,
      commitPrefix: "feat(opentui)",
      dryRun: DRY_RUN,
    },
    {}
  );
});

Effect.runPromise(program)
  .then((result) => {
    console.log("\n Pipeline complete:\n");
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err: unknown) => {
    console.error(" Pipeline failed:", err);
    process.exit(1);
  });
