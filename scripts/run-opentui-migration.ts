/**
 * run-opentui-migration — ONE TASK AT A TIME with OpenTUI docs injected.
 * Usage: npx tsx scripts/run-opentui-migration.ts [--dry-run] [--from=N]
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";

const GATES_DIR = "/home/lucian/gates";
const DRY_RUN   = process.argv.includes("--dry-run");
const FROM_TASK = parseInt(process.argv.find(a => a.startsWith("--from="))?.split("=")[1] ?? "1", 10);

const OPENTUI_DOCS = `
## @opentui/core API (Bun only, NO React/JSX)

### Init
\`\`\`ts
import { createCliRenderer, BoxRenderable, TextRenderable, InputRenderable,
  MarkdownRenderable, ScrollBoxRenderable, SelectRenderable,
  InputRenderableEvents, SelectRenderableEvents } from "@opentui/core";
const renderer = await createCliRenderer({ targetFps: 30, useMouse: true, exitOnCtrlC: false });
renderer.start();
const ctx = renderer.renderContext;
\`\`\`

### Layout
\`\`\`ts
const root = new BoxRenderable(ctx, { flexDirection: "column", width: "100%", height: "100%" });
renderer.root.add(root);
const header = new BoxRenderable(ctx, { height: 1, border: ["bottom"], borderColor: "#00ffff" });
const body   = new BoxRenderable(ctx, { flexGrow: 1 });
const footer = new BoxRenderable(ctx, { height: 3 });
root.add(header); root.add(body); root.add(footer);
\`\`\`

### Text
\`\`\`ts
const t = new TextRenderable(ctx, { content: "hello", fg: "#ffffff" });
parent.add(t);
t.content = "updated";  // mutate directly, no setState
\`\`\`

### Input
\`\`\`ts
const input = new InputRenderable(ctx, { placeholder: "Type…", flexGrow: 1, height: 1 });
input.on(InputRenderableEvents.ENTER, () => { const v = input.value; input.value = ""; handleSubmit(v); });
renderer.focusRenderable(input);
\`\`\`

### Markdown streaming
\`\`\`ts
const md = new MarkdownRenderable(ctx, { streaming: true, flexGrow: 1 });
parent.add(md);
md.content += chunk;    // append token by token
md.streaming = false;   // MUST set false when done
\`\`\`

### ScrollBox
\`\`\`ts
const scroll = new ScrollBoxRenderable(ctx, { flexGrow: 1, scrollY: true, stickyScroll: true });
scroll.add(childRenderable);
\`\`\`

### Select list
\`\`\`ts
const sel = new SelectRenderable(ctx, { options: [{ label: "A" }, { label: "B" }], flexGrow: 1 });
sel.on(SelectRenderableEvents.ITEM_SELECTED, () => onSelect(items[sel.selectedIndex]));
renderer.focusRenderable(sel);
\`\`\`

### Keyboard
\`\`\`ts
const handler = (key: { name: string; ctrl: boolean }) => {
  if (key.ctrl && key.name === "c") renderer.destroy();
  if (key.name === "escape") goBack();
};
renderer.keyInput.on("keypress", handler);
// ALWAYS remove in destroy(): renderer.keyInput.off("keypress", handler);
\`\`\`

### Rules
- createCliRenderer() is ASYNC — must await
- NO React, NO JSX, NO hooks — pure classes
- Mutate renderables directly (no re-render needed)
- renderer.renderContext = ctx for all constructors
- renderer.root.add(screen) to show, screen.destroy() to remove
- Every screen stores its keyHandler and calls off() in destroy()
`;

const TASKS = [
  {
    id: 1,
    name: "Bun + @opentui/core setup",
    prompt: `Working in ${GATES_DIR}:
1. bun add @opentui/core (if not already installed)
2. Update package.json: scripts.build = "bun run tsc", scripts.dev = "bun run src/index.ts"
3. Remove from dependencies: ink, react, react-dom, @types/react, ink-text-input (if present)
4. Add bun-types to devDependencies
5. Do NOT change any source files yet
6. Show final package.json dependencies section`,
    commitMsg: "feat(opentui): bun + @opentui/core deps",
  },
  {
    id: 2,
    name: "Shared primitives (no React)",
    prompt: `Create these 3 files in ${GATES_DIR}/src/ui/tui/shared/:

**colors.ts**:
export const COLORS = { cyan: "#00ffff", green: "#00ff00", yellow: "#ffff00", red: "#ff5555", gray: "#888888", white: "#ffffff", dim: "#555555", magenta: "#ff55ff" } as const;

**types.ts**: Copy ChatMessage, ToolCallItem, KanbanFinding, ThinkingBlockData interfaces from the existing tsx files. NO React imports — pure TypeScript types only.

**sse.ts**: Copy the parseSseChunk function from ${GATES_DIR}/src/ui/tui/screens/chat.tsx. It parses "event: X\\ndata: Y" SSE format. No dependencies.`,
    commitMsg: "feat(opentui): shared colors, types, SSE parser",
    checkBuild: true,
  },
  {
    id: 3,
    name: "App entry + renderer init",
    prompt: `Rewrite ${GATES_DIR}/src/ui/tui/index.ts — remove ALL React/Ink, use @opentui/core:

\`\`\`typescript
import { createCliRenderer } from "@opentui/core";
import type { LoadedHarness } from "../harness/loader.js";

export async function startTUI(harnesses: LoadedHarness[]): Promise<void> {
  const renderer = await createCliRenderer({ targetFps: 30, useMouse: true, exitOnCtrlC: false });
  renderer.start();
  const { TextRenderable } = await import("@opentui/core");
  const t = new TextRenderable(renderer.renderContext, {
    content: "gates — migrating to OpenTUI...", fg: "#00ffff",
  });
  renderer.root.add(t);
  await new Promise<void>(resolve => {
    renderer.keyInput.on("keypress", (k: {name:string;ctrl:boolean}) => {
      if (k.ctrl && k.name === "c") { renderer.destroy(); resolve(); }
    });
    renderer.on("destroy", resolve);
  });
}
\`\`\`

Also update ${GATES_DIR}/src/index.ts:
- Find the Ink render() block and replace with: await (await import("./ui/tui/index.js")).startTUI(harnesses)
- Remove: import React, render from ink, App import`,
    commitMsg: "feat(opentui): entry point with createCliRenderer",
    checkBuild: true,
  },
  {
    id: 4,
    name: "HarnessSelect screen",
    prompt: `Create ${GATES_DIR}/src/ui/tui/screens/harness-select.ts:

A screen class (no React) that shows a list of harnesses to select.
- Layout: header (title) + SelectRenderable (list) + footer (hints)
- On ITEM_SELECTED: POST to http://localhost:3583/api/default-session, then call onSelect(harness, sessionId)
- Keys: q = quit, Esc = quit
- Constructor: (ctx, renderer, harnesses[], onSelect callback)
- destroy(): removes keyHandler, destroys root BoxRenderable

Use SelectRenderable for the list. Import DEFAULT_PORT from "../../server/index.js".`,
    commitMsg: "feat(opentui): HarnessSelect screen",
    checkBuild: true,
  },
  {
    id: 5,
    name: "Chat screen",
    prompt: `Create ${GATES_DIR}/src/ui/tui/screens/chat.ts:

A chat screen class (no React) with:
- Header: harness name + session ID
- ScrollBoxRenderable for messages (stickyScroll: true, scrollY: true)
- TextRenderable for current thinking/streaming text (below scroll box)
- BoxRenderable for current tool call indicator
- InputRenderable at bottom for user input (height: 1)
- Status TextRenderable (thinking…/calling tools…/ready)

SSE handling (use parseSseChunk from shared/sse.ts):
- thinking/start → status text = "pensando…"
- tool_call → show tool name in indicator
- delta → append to thinking text
- done → add message to scroll box, clear thinking
- error → show error message

Keys: Esc = call onBack(), Ctrl+K = reserved for kanban
Constructor: (ctx, renderer, harness, sessionId, onBack)
destroy(): cleanup listeners and renderables`,
    commitMsg: "feat(opentui): Chat screen",
    checkBuild: true,
  },
  {
    id: 6,
    name: "Router + wire everything",
    prompt: `Create ${GATES_DIR}/src/ui/tui/router.ts:

\`\`\`typescript
import type { CliRenderer } from "@opentui/core";
import type { LoadedHarness } from "../harness/loader.js";

export class AppRouter {
  private current: { destroy(): void } | null = null;
  constructor(private renderer: CliRenderer, private harnesses: LoadedHarness[]) {}

  async init() { await this.showHarnessSelect(); }

  async showHarnessSelect() {
    this.current?.destroy();
    const { HarnessSelectScreen } = await import("./screens/harness-select.js");
    const s = new HarnessSelectScreen(this.renderer.renderContext, this.renderer, this.harnesses,
      (h, id) => this.showChat(h, id));
    this.renderer.root.add(s.root);
    this.current = s;
  }

  async showChat(harness: LoadedHarness, sessionId: string) {
    this.current?.destroy();
    const { ChatScreen } = await import("./screens/chat.js");
    const s = new ChatScreen(this.renderer.renderContext, this.renderer, harness, sessionId,
      () => this.showHarnessSelect());
    this.renderer.root.add(s.root);
    this.current = s;
  }
}
\`\`\`

Update ${GATES_DIR}/src/ui/tui/index.ts to use AppRouter:
\`\`\`typescript
import { AppRouter } from "./router.js";
const router = new AppRouter(renderer, harnesses);
await router.init();
\`\`\`

Then: npx tsc --noEmit in ${GATES_DIR} — fix any TypeScript errors.`,
    commitMsg: "feat(opentui): router + wire all screens",
    checkBuild: true,
  },
];

function runTask(task: typeof TASKS[0]): boolean {
  const fullPrompt = [
    OPENTUI_DOCS,
    "---",
    `## Task ${task.id}/${TASKS.length}: ${task.name}`,
    "",
    task.prompt,
    "",
    task.checkBuild ? [
      "After writing the files:",
      `1. cd ${GATES_DIR} && npx tsc --noEmit 2>&1 | head -40`,
      "2. Fix ALL TypeScript errors before finishing",
      `3. git -C ${GATES_DIR} diff --stat`,
      DRY_RUN ? "4. DRY RUN — do NOT commit" : `4. git -C ${GATES_DIR} add -A && git -C ${GATES_DIR} -c user.email="lucian@metricasboss.com.br" -c user.name="Lucian" commit -m "${task.commitMsg}"`,
    ].join("\n") : (DRY_RUN ? "DRY RUN — do NOT commit" : `git -C ${GATES_DIR} add -A && git -C ${GATES_DIR} -c user.email="lucian@metricasboss.com.br" -c user.name="Lucian" commit -m "${task.commitMsg}"`),
  ].join("\n");

  console.log(`\n${"─".repeat(60)}`);
  console.log(`▶ Task ${task.id}/${TASKS.length}: ${task.name}`);
  console.log(`${"─".repeat(60)}`);

  const result = spawnSync("claude", [
    "-p", fullPrompt,
    "--model", "claude-sonnet-4-6",
    "--allowedTools", "Bash,Read,Write,Glob,Grep,Edit",
    "--output-format", "json",
  ], { cwd: GATES_DIR, stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });

  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  if (stderr) process.stderr.write(stderr.slice(0, 500));

  try {
    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    console.log(parsed.result?.slice(0, 400) ?? "(no output)");
    return !parsed.is_error && result.status === 0;
  } catch {
    console.log(stdout.slice(0, 400));
    return result.status === 0;
  }
}

async function main() {
  const tasks = TASKS.filter(t => t.id >= FROM_TASK);
  console.log(`\n◆ OpenTUI Migration — ${tasks.length} tasks, dry=${DRY_RUN}`);

  const results: Array<{ id: number; name: string; ok: boolean }> = [];

  for (const task of tasks) {
    const ok = runTask(task);
    results.push({ id: task.id, name: task.name, ok });
    if (!ok) {
      console.log(`\n✗ Task ${task.id} failed — run with --from=${task.id} to retry`);
      break;
    }
  }

  console.log("\n◆ Summary:");
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.id}. ${r.name}`);
  }
}

main().catch(console.error);
