# Architecture

## Core concepts

### Atomic Gates

Atomic gates are composable, type-safe primitives that can be safely combined. Each gate does one thing and fails explicitly — no silent errors. Built on Effect v4, which makes every operation's error channel explicit in the type system.

```typescript
// Every operation declares its possible failures
const result: Effect.Effect<string, SandboxError> = sandbox.readFile("path");
```

### Harness

A harness is a configured agent runtime — it binds a provider, roles, skills, and session management together. Think of it as the "brain" that orchestrates everything else.

```
Harness
  ├── Provider (which LLM to call)
  ├── Roles (system prompts with optional compaction per role)
  ├── Skills (reusable workflows)
  └── Session (persisted conversation history)
```

### Skills

Skills are state machines defined in YAML. Each state is either a tool call, an LLM prompt, or a delegation to another skill. Transitions can be conditional.

```
State A → tool call → output
State B → LLM prompt with {{lastOutput}} → output
State C → delegate to skill X with inputs
```

### Sandbox

Every tool execution runs inside a sandbox that controls:
- **CWD**: restricts file operations to the project directory
- **Credentials**: only explicitly granted env vars reach the process
- **Path traversal**: `../../etc/passwd` is blocked at the sandbox level

### Connectors

Connectors package external CLIs as tools. A `connector.yaml` declares commands using `defineCommand` — no code required. Credentials are interpolated at load time and isolated per agent.

```
.gates/connectors/github/connector.yaml
  → defineCommand("gh", { allowedSubcommands: ["issue", "pr"] })
  → Tool available in any harness that loads the registry
```

## Data flow

```
User input
    │
    ▼
Harness.init() → HarnessSession
    │
    ▼
session.prompt(input)
    │  ├── builds messages from history + system prompt
    │  ├── applies CompactionScope if needed
    │  └── calls provider.chat(messages, tools?)
    │
    ▼
Provider response
    │  ├── if toolCalls → execute via Sandbox → append results → loop
    │  └── if text → stream back
    │
    ▼
SessionHistory.appendMessage()
    │
    ▼
FileSessionStore.save()     ← persists to ~/.gates/sessions/
```

## Session persistence

Sessions are stored as append-only entry logs. Each entry is a `MessageEntry`, `CompactionEntry`, or `BranchSummaryEntry`. The `buildContext()` method reconstructs the message list, applying compactions transparently.

```
SessionHistory
  ├── entries: [msg, msg, compaction, msg, msg, ...]
  └── buildContext() → [summaryMessage, ...recentMessages]
```

## Context compaction

Two independent systems:

1. **Agent-level** (`makeAgent`): triggered by token budget or entry count
2. **Harness-level** (`CompactionScope`): configured per role or per call

When triggered, the LLM summarizes older messages. The summary replaces them in `buildContext()` output, keeping the context window small.

## Effect v4

All async operations return `Effect<A, E>` — never `Promise<A>`. This means:
- Errors are typed and visible at compile time
- Composition via `Effect.gen`, `Effect.map`, `Effect.flatMap`
- No `try/catch` — use `Effect.result` or `Effect.catch`
- Concurrent execution with `Effect.all({ concurrency: N })`
