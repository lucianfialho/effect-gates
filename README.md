# effect-gates

**AI Agent Harness Framework for TypeScript**

Build composable, type-safe AI agents that call tools, run pipelines, and persist state — powered by [Effect v4](https://effect.website/).

```bash
pnpm add @gates-effect/runtime @gates-effect/providers
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
| [`@gates-effect/runtime`](packages/runtime) | Agent, Harness, SessionHistory, Compaction, Events |
| [`@gates-effect/providers`](packages/providers) | Anthropic, MiniMax, OpenAI — with tool calling |
| [`@gates-effect/skills`](packages/skills) | YAML state machines, Tasks, Connectors, Interpolation |
| [`@gates-effect/sandbox`](packages/sandbox) | Local execution with path traversal and credential isolation |
| [`@gates-effect/gates`](packages/gates) | Atomic primitives: bash safety, dedup, file metadata |
| [`@gates-effect/harness-ui`](packages/harness-ui) | Terminal UI — chat, sidebar, skill visualization |
| [`@gates-effect/cli`](packages/cli) | CLI: `gates run`, `chat`, `resume`, `dev`, `skill` |

---

## Quick start

### Chat agent

```typescript
import { makeAgent } from "@gates-effect/runtime";
import { makeMiniMaxProvider } from "@gates-effect/providers";
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
import { createHarness, role, toolsMap } from "@gates-effect/runtime";
import { makeLocalSandbox } from "@gates-effect/sandbox";

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
pnpm add @gates-effect/harness-ui
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

## License

MIT
