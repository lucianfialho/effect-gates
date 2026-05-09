# API Reference

Full API documentation for all packages.

## @gates/runtime

### makeAgent

```typescript
makeAgent(config: AgentConfig): Effect.Effect<Agent>
```

Creates an agent with session management and optional compaction.

```typescript
const agent = yield* makeAgent({
  model: "claude-sonnet-4-6",
  provider,
  systemPrompt: "You are...",
  compactionConfig: {
    thresholdTokens: 15000,
    maxEntriesBeforeCompaction: 100,
  },
});

const r = yield* agent.run("Hello");
const r2 = yield* agent.resume(r.session.id, "Follow up");
```

### createHarness

```typescript
createHarness(config: HarnessConfig): { init, roles, skills }
```

```typescript
const harness = createHarness({
  provider,
  roles: [
    role("engineer", "You are a senior engineer.", {
      compaction: { maxContextTokens: 8000, thresholdPercent: 80 },
    }),
  ],
});

const session = yield* harness.init({ role: "engineer" });
const r = yield* session.prompt("Review this PR");
const r2 = yield* session.prompt("With strict rules", {
  compaction: { maxContextTokens: 4000 },  // call-level override
});
```

### defineCommand

```typescript
defineCommand(config: CommandConfig): Tool
```

```typescript
const git = defineCommand({
  name: "git",
  executable: "git",
  allowedSubcommands: ["status", "log", "diff", "add", "commit"],
  baseArgs: ["--no-pager"],
  env: { GIT_AUTHOR_NAME: "Agent" },
});
```

### runAgentLoop

```typescript
runAgentLoop(llmCall, tools, messages, config?): Effect.Effect<AgentLoopResult>
```

Manual tool-calling loop for advanced use cases.

```typescript
const result = yield* runAgentLoop(
  (messages) => provider.chat(messages, tools),
  toolsMap(sandbox),
  initialMessages,
  { maxIterations: 10, toolConcurrency: "unbounded" }
);
```

### SessionHistory

```typescript
const history = yield* SessionHistory.fromData(data); // or .empty()
yield* history.appendMessage(msg, "user");
const messages = yield* history.buildContext();
const data = yield* history.toData({ sessionId });
```

---

## @gates/providers

All providers share the same interface:

```typescript
provider.chat(messages: Message[], tools?: Tool[]): Effect.Effect<ChatResponse, ProviderError>
```

```typescript
import { makeMiniMaxProvider, makeAnthropicProvider, makeOpenAIProvider } from "@gates/providers";

const provider = makeAnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4-6",
  baseUrl: "...", // optional
});
```

---

## @gates/sandbox

```typescript
const sandbox = yield* makeLocalSandbox({
  cwd: process.cwd(),
  isolated: true,                          // block process.env passthrough
  credentials: { GH_TOKEN: "..." },        // only these reach commands
  timeout: 30000,
});

yield* sandbox.run("git status");
yield* sandbox.readFile("src/index.ts");
yield* sandbox.writeFile("out.json", content);
const files = yield* sandbox.listDir("src/");
```

---

## @gates/skills

### makeSkillExecutor

```typescript
const executor = yield* makeSkillExecutor(config, {
  executeTool: (name, params, ctx) => Effect.succeed(...),
  executePrompt: (prompt, ctx) => Effect.succeed(...),
  onEvent: (event) => console.log(event.type, event.state),
  basePath: process.cwd(),
  maxTransitions: 100,
});

const ctx = yield* executor.execute({ target: "src/auth.ts" });
```

### loadConnectors

```typescript
const registry = yield* loadConnectors(".gates/connectors", {
  GH_TOKEN: process.env.GH_TOKEN!,
});

registry.allTools()   // Map<string, Tool>
registry.allSkills()  // SkillConfig[]
registry.allDocs()    // string
```

### makeTaskRunner

```typescript
const queue = yield* makeTaskQueue();

const t1 = yield* queue.add({ name: "analyze", skill: "analyze", input: { target: "src/" } });
const t2 = yield* queue.add({ name: "report", skill: "report", input: {}, dependencies: [t1] });

const runner = makeTaskRunner(queue, skills, executorConfig);
const results = yield* runner.runAll({ concurrency: 3, onTaskComplete: (t) => console.log(t.name) });
```

---

## @gates/core

```typescript
import { bashSafety, runBash, readLarge, dedupLines, dedupSimilar, getFileMetadata } from "@gates/core";

yield* bashSafety()("git status");              // validates before executing
const result = yield* runBash("git log -5");
const content = yield* readLarge("large.log");
const unique = yield* dedupLines(lines);
const similar = yield* dedupSimilar(lines, 0.8);
const meta = yield* getFileMetadata("src/index.ts");
```

---

Full type definitions are available in each package's `dist/*.d.ts` files.
