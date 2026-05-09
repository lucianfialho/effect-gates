# Building a Harness

A harness combines a provider, roles, tools, and session management into a reusable agent configuration.

## 1. Define the harness file

Create `.gates/harnesses/<name>/harness.js`:

```javascript
export default {
  name: "Code Reviewer",
  description: "Reviews pull requests for security and clarity",

  provider: {
    type: "anthropic",             // "anthropic" | "minimax" | "openai"
    model: "claude-sonnet-4-6",
    // apiKey: "sk-...",           // optional — falls back to env var
  },

  systemPrompt: `You are a senior code reviewer.
Focus on: security vulnerabilities, performance, and code clarity.
Always explain your reasoning.`,

  tools: ["read", "grep", "glob"], // tools from sandbox + connectors

  roles: [
    {
      name: "strict",
      systemPrompt: "Be rigorous. Report every issue, no matter how small.",
    },
    {
      name: "mentor",
      systemPrompt: "Be educational. Explain why each issue matters.",
    },
  ],
  defaultRole: "strict",

  compaction: {
    maxContextTokens: 12000,
    thresholdPercent: 80,
    keepRecentMessages: 6,
  },
};
```

## 2. Use it programmatically

```typescript
import { createHarness, role, toolsMap } from "@gates/runtime";
import { makeLocalSandbox } from "@gates/sandbox";
import { makeAnthropicProvider } from "@gates/providers";

const sandbox = yield* makeLocalSandbox({ cwd: process.cwd() });
const provider = makeAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });

const harness = createHarness({
  provider: {
    chat: (messages) =>
      Effect.map(provider.chat(messages), (r) => ({ content: r.content, usage: r.usage })),
  },
  roles: [
    role("strict", "Be rigorous. Report every issue.", {
      compaction: { maxContextTokens: 12000, thresholdPercent: 80 },
    }),
    role("mentor", "Be educational. Explain the why."),
  ],
});

const session = yield* harness.init({ role: "strict" });

const r1 = yield* session.prompt("Review src/auth.ts");
const r2 = yield* session.prompt("What about the token expiry logic?");
// r2 remembers the context from r1
```

## 3. Add connectors

```typescript
import { loadConnectors } from "@gates/skills";

const registry = yield* loadConnectors(".gates/connectors", {
  GH_TOKEN: process.env.GH_TOKEN!,
});

// Merge sandbox tools with connector tools
const tools = new Map([
  ...toolsMap(sandbox),
  ...registry.allTools(),
]);

// Inject connector docs into system prompt
const systemPrompt = `You are a code reviewer.\n\n${registry.allDocs()}`;
```

## 4. Use it in harness-ui

Place the harness file in `.gates/harnesses/<name>/harness.js` and run:

```bash
harness-ui --dir /your/project
```

The harness appears in the selection screen automatically.

## Harness config reference

| Field | Type | Description |
|---|---|---|
| `name` | string | Display name in harness-ui |
| `description` | string | Shown in selection screen |
| `provider` | object | `{ type, model?, apiKey? }` |
| `systemPrompt` | string | Default system prompt |
| `tools` | string[] | Sandbox tools to enable |
| `roles` | object[] | `{ name, systemPrompt, model? }` |
| `defaultRole` | string | Role used if none specified |
| `compaction` | object | `{ maxContextTokens, thresholdPercent, keepRecentMessages }` |

## Provider types

| `type` | Model default | Env var |
|---|---|---|
| `"anthropic"` | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| `"minimax"` | `MiniMax-M2.7` | `MINIMAX_API_KEY` |
| `"openai"` | `gpt-4o` | `OPENAI_API_KEY` |
