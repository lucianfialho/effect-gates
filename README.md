# effect-gates

**AI Agent Harness Framework for TypeScript**

Build composable, type-safe AI agents that call tools, run pipelines, and persist state — powered by [Effect v4](https://effect.website/).

```bash
pnpm add @gates/runtime @gates/providers
```

---

## Why effect-gates?

Most AI frameworks give you a chat loop. effect-gates gives you a **harness** — a structured runtime where agents call real tools, run YAML-defined skill pipelines, isolate credentials per agent, compact context automatically, and stream execution in a terminal UI.

Built on Effect v4 for end-to-end type safety and composability.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        harness-ui                           │
│  Terminal UI  ·  Sidebar  ·  Skill visualization  ·  SSE    │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                         runtime                             │
│  Agent  ·  Harness  ·  SessionHistory  ·  Compaction        │
└────┬─────────────────┬────────────────────┬─────────────────┘
     │                 │                    │
┌────▼────┐    ┌───────▼──────┐    ┌────────▼────────┐
│providers│    │    skills    │    │    sandbox      │
│Anthropic│    │ State machine│    │ Local execution │
│MiniMax  │    │ YAML / code  │    │ Path traversal  │
│OpenAI   │    │ Tasks / Connectors  │ Credential isolation │
└─────────┘    └──────────────┘    └─────────────────┘
                      │
              ┌───────▼────────┐
              │     gates      │
              │ Atomic prims.  │
              │ bash · dedup · │
              │ metadata · ... │
              └────────────────┘
```

---

## Packages

| Package | Description |
|---|---|
| [`@gates/runtime`](packages/runtime) | Agent, Harness, SessionHistory, Compaction, Events |
| [`@gates/providers`](packages/providers) | Anthropic, MiniMax, OpenAI — with tool calling |
| [`@gates/skills`](packages/skills) | YAML state machines, Tasks, Connectors, Interpolation |
| [`@gates/sandbox`](packages/sandbox) | Local execution with path traversal and credential isolation |
| [`@gates/core`](packages/gates) | Atomic primitives: bash safety, dedup, file metadata |
| [`@gates/harness-ui`](packages/harness-ui) | Terminal UI — chat, sidebar, skill visualization |
| [`@gates/cli`](packages/cli) | CLI: `gates run`, `chat`, `resume`, `dev`, `skill` |

---

## Quick start

### Chat agent

```typescript
import { makeAgent } from "@gates/runtime";
import { makeMiniMaxProvider } from "@gates/providers";
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const provider = makeMiniMaxProvider({ apiKey: process.env.MINIMAX_API_KEY! });
  const agent = yield* makeAgent({ model: "MiniMax-M2.7", provider });

  const r1 = yield* agent.run("What files are in the src/ directory?");
  const r2 = yield* agent.resume(r1.session.id, "Which one is the entry point?");

  console.log(r2.content);
});

Effect.runPromise(program);
```

### Harness with roles and tools

```typescript
import { createHarness, role, toolsMap } from "@gates/runtime";
import { makeLocalSandbox } from "@gates/sandbox";

const sandbox = yield* makeLocalSandbox({ cwd: process.cwd() });

const harness = createHarness({
  provider,
  roles: [
    role("engineer", "You are a senior TypeScript engineer.", {
      compaction: { maxContextTokens: 12000, thresholdPercent: 80 },
    }),
  ],
});

const session = yield* harness.init({ role: "engineer" });
const result = yield* session.prompt("Refactor this function to use Effect");
```

### YAML skill pipeline

```yaml
# .gates/skills/refactor/skill.yaml
name: refactor
initialState: read

states:
  - id: read
    tool: read
    params:
      path: "{{inputs.target}}"

  - id: analyze
    prompt: |
      Analyze this code:
      {{lastOutput}}

      {% if inputs.strict %}Apply strict rules.{% endif %}

  - id: done

transitions:
  - from: read
    to: analyze
  - from: analyze
    to: done
```

```bash
gates skill refactor --input '{"target": "src/auth.ts", "strict": true}'
```

### Connector (external CLI as tool)

```yaml
# .gates/connectors/github/connector.yaml
name: github
commands:
  - name: gh
    executable: gh
    allowedSubcommands: [issue, pr, repo]
    env:
      GH_TOKEN: "{{credentials.GH_TOKEN}}"
```

```typescript
const registry = yield* loadConnectors(".gates/connectors", {
  GH_TOKEN: process.env.GH_TOKEN!,
});
// registry.allTools() → Map<string, Tool> ready to use
```

---

## Terminal UI

```bash
pnpm add @gates/harness-ui
harness-ui --dir /your/project
```

Creates a local HTTP server + Ink TUI. Commands in chat: `/skill <name>`, `/skills`, `/sessions`.

```
┌─ Meeting Issues ──────────────────────────────────────────┐
│ /sessions  /skills  /skill <name>  Ctrl+S sidebar  Esc    │
├─ Action Items ──────┐ │                                   │
│ ✓ Fix auth bug      │ │ ❯ /skill extract-action-items     │
│ ⟳ Update API docs   │ │   conference_id=abc123            │
│ ○ PR template       │ │                                   │
└─────────────────────┘ │ ⟳ get_transcript  fetching...    │
                        │ ✓ extract         7 items found  │
```

---

## Real-world example: Meeting → Issues

Convert Google Meet transcripts into GitHub Issues automatically.

```
gws meet conferenceRecords list          →  list recent meetings
gws meet transcripts entries list        →  get transcript text
LLM: extract action items → JSON         →  structured items
gh issue create --title "..." --body ... →  GitHub Issues created
```

**See** [`docs/examples/meeting-to-issues.md`](docs/examples/meeting-to-issues.md)

---

## Key features

- **Tool calling** on all providers (Anthropic, MiniMax, OpenAI)
- **Session persistence** with `FileSessionStore` — survives restarts
- **Context compaction** per role or per call — controls token spend
- **Credential isolation** per agent — `isolated: true` prevents env leaks
- **`defineCommand`** — wrap any CLI as a type-safe tool with allowlist
- **Connector system** — bundle tools + skills + docs as installable plugins
- **Parallel tasks** — `makeTaskRunner` with dependency graph
- **Interpolation** — `{{file:path}}`, `{% if cond %}...{% endif %}` in prompts
- **Real-time skill events** — `onEvent` callback for streaming state machine progress

---

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Install, first agent, first skill |
| [Architecture](docs/architecture.md) | Core concepts explained |
| [Building a harness](docs/guides/building-a-harness.md) | Step-by-step guide |
| [Connector system](docs/guides/connectors.md) | Wrap any CLI as a tool |
| [Skills reference](docs/guides/skills.md) | YAML format, interpolation, guards |
| [API reference](docs/api-reference.md) | Full package API |
| [Meeting → Issues example](docs/examples/meeting-to-issues.md) | Real use case walkthrough |

---

## Development

```bash
git clone https://github.com/lucianfialho/effect-gates
cd effect-gates
pnpm install
pnpm build
pnpm test        # 71 tests
```

Monorepo with pnpm workspaces. Each package is independently typechecked.

---

## Changelog

### [0.2.0] — 2026-05-09

#### New features

**Reasoning models**
- `AnthropicConfig.thinking: { enabled, budgetTokens? }` — extended thinking via Claude 3.7+ (streams `reasoningDetails` in `ChatResponse`)
- `OpenAIConfig.reasoningEffort: "low" | "medium" | "high"` — native support for o1/o3 models (disables temperature/max_tokens automatically)

**Patch engine** (`@gates/runtime`)
- `applyPatch(content, patch)` — applies unified diffs with ±10 line fuzzy offset matching
- `makePatchTool(sandbox)` — agent tool for complex multi-location code edits

**Script safety** (`@gates/core`)
- `checkScript(script, config)` — validates LLM-generated JS/TS before execution
- Blocks: `eval()`, `new Function()`, `process.exit()`, `child_process` imports, template literal injection
- `preprocessScript(script)` — check pipeline; `sanitizeTemplateLiterals(script)` — escapes backtick issues

**Semantic search** (`@gates/core`)
- `buildIndex(rootPath, openAiApiKey)` — chunks codebase by function/class boundaries + generates OpenAI embeddings
- `searchIndex(index, query, apiKey, { topK })` — cosine similarity search with natural language queries
- `formatResults(results)` — formats results as Markdown code blocks for LLM context injection
- Indexes `.ts`, `.tsx`, `.js`, `.mjs`, `.py`, `.go`, `.rs`, `.md` files

**Meeting → Issues pipeline**
- `@gates/harness-ui` sidebar — split layout (36 cols) with `Ctrl+S` toggle, auto-opens on skill completion
- `sidebar_update` SSE event for real-time sidebar population from server or skills
- Google Workspace connector (`.gates/connectors/google-workspace/`) via `gws` CLI — `gws_calendar`, `gws_meet`, `gws_drive`
- GitHub connector (`.gates/connectors/github/`) via `gh` CLI
- Skills: `list-meetings`, `extract-action-items`, `create-github-issues`
- Harness `meeting-issues` — transcript → structured action items → GitHub Issues (no code execution)

**Sessions list** (`@gates/harness-ui`)
- `GET /api/sessions` — lists persisted sessions from FileSessionStore with preview + relative timestamps
- `POST /api/sessions { resumeSessionId }` — resume any previous session
- `DELETE /api/sessions/:id` — delete session
- `SessionsList` TUI screen: `↑↓` navigate, `↵` resume, `d` delete
- Accessible via `s` key in harness select and `/sessions` command in chat

**Connector system extensions**
- `tools.js` / `tools.mjs` support in connector directories — `async (credentials) => Tool[]` factory
- Programmatic tools merged with declarative `commands` from `connector.yaml`

#### Breaking changes / removals

- **`@gates-effect/wiki` removed** — replaced by semantic search. Index `.md` files in `.gates/docs/` with `buildIndex` for natural language search instead of keyword matching.

---

### [0.1.0] — 2026-05-09

#### `@gates/harness-ui`
- Terminal UI with sessions list, skill visualization, tool calling display, SSE streaming
- Skills in chat: `/skill <name>`, `/skills`, `/sessions`, `/clear`
- Server: Hono HTTP + SSE on localhost:3583

#### `@gates/skills`
- `{{file:path}}` file injection and `{% if/else/endif %}` conditionals in prompts
- `onEvent` callback in `SkillExecutorConfig` for real-time streaming
- `makeTaskQueue`, `makeFileTaskQueue`, `makeTaskRunner` — parallel task execution with dependency graph
- Connector system: `loadConnectors`, `connector.yaml`, `{{credentials.KEY}}` injection
- `SkillExecutorConfig.basePath` for `{{file:...}}` resolution

#### `@gates/runtime`
- `CompactionScope` — compaction per role and per call (`PromptOptions.compaction`)
- `defineCommand` — wrap any CLI as an isolated tool with subcommand allowlist
- `createHarness` session history between prompts (was stateless)
- `AgentLoopConfig.toolConcurrency: "sequential" | "unbounded" | number`

#### `@gates/sandbox`
- `SandboxConfig.isolated` + `credentials` — blocks `process.env` passthrough per agent

#### `@gates/providers`
- Tool calling on Anthropic (content blocks), OpenAI (role: tool messages), MiniMax
- All three providers with unified `provider.chat(messages, tools?)` interface

#### Migration to Effect v4
- `effect@4.0.0-beta.64` across all packages; `@effect/schema` removed
- API renames: `either→result`, `catchAll→catch`, `fork→forkChild`, `try→try_`
- Tags `Left/Right → Failure/Success`, props `.left/.right → .failure/.success`

#### Bug fixes and security
- Message duplication in context, `PubSub.publish` never executing, `firstKeptEntryId` wrong
- Shell injection in `makeGlobTool`/`makeGrepTool` → `spawn` with arg arrays
- `new Function()` in `evaluateGuard`/`evaluateWhen` → direct comparisons
- Path traversal in `makeLocalSandbox` → `assertWithinCwd`

---

## License

MIT
