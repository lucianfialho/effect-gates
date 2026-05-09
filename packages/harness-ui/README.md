# harness-ui

Terminal UI for [gates-effect](https://github.com/lucian/gates-effect) harnesses. Inspired by [OpenCode](https://github.com/anomalyco/opencode/).

```
┌─────────────────────────────────────────────────────────────┐
│ ◆ Harness UI  Select a harness to start                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ▶  Code Assistant   minimax/MiniMax-M2.7                    │
│    Engineering assistant with filesystem access             │
│                                                             │
│    Refactor Bot   anthropic/claude-sonnet-4-6               │
│    Automated refactoring with SOLID methodology             │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ ↑↓ navigate  ↵ select  q quit                               │
└─────────────────────────────────────────────────────────────┘
```

## Architecture

```
harness-ui start
    │
    ├── Hono HTTP server (localhost:3583)
    │     ├── GET  /api/harnesses          list available harnesses
    │     ├── POST /api/sessions           create session
    │     ├── POST /api/sessions/:id/chat  send message (SSE response)
    │     └── GET  /api/sessions/:id/history
    │
    └── Ink TUI (React for terminal)
          ├── HarnessSelect  arrow key selection
          └── Chat           streaming chat with history
```

## Install

```bash
npm install -g harness-ui
# or
pnpm add -g harness-ui
```

## Usage

```bash
# Start in current directory (discovers .gates/harnesses/)
harness-ui

# Start in a specific directory
harness-ui --dir /path/to/project

# List discovered harnesses without launching UI
harness-ui list
```

## Creating a harness

Create `.gates/harnesses/<name>/harness.js` (or `.ts` with tsx):

```js
import { defineHarness } from "harness-ui";

export default defineHarness({
  name: "Code Reviewer",
  description: "Reviews pull requests and suggests improvements",

  provider: {
    type: "anthropic",          // "anthropic" | "minimax" | "openai"
    model: "claude-sonnet-4-6",
    apiKey: process.env.ANTHROPIC_API_KEY,  // optional, falls back to env var
  },

  systemPrompt: `You are a senior code reviewer focused on:
- Security vulnerabilities
- Performance issues
- Code clarity and maintainability`,

  tools: ["read", "grep", "glob"],  // tools available to the agent

  roles: [
    {
      name: "reviewer",
      systemPrompt: "Focus on correctness and security.",
    },
    {
      name: "mentor",
      systemPrompt: "Be educational. Explain the why behind each suggestion.",
    },
  ],
  defaultRole: "reviewer",

  compaction: {
    maxContextTokens: 12000,   // compact history when approaching this
    thresholdPercent: 80,
    keepRecentMessages: 6,
  },
});
```

## API keys

harness-ui reads API keys from environment variables:

| Provider | Variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |

Or set `apiKey` directly in your harness config.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `↑` `↓` | Navigate harness list |
| `↵` | Select harness |
| `q` | Quit (harness selection screen) |
| `Esc` / `Ctrl+B` | Back to harness selection |
| `Ctrl+C` | Force quit |

## Project structure expected

```
your-project/
└── .gates/
    └── harnesses/
        ├── code-reviewer/
        │   └── harness.js
        └── refactor-bot/
            └── harness.js
```

harness-ui automatically discovers all harnesses in `.gates/harnesses/`.
Sessions are persisted to `~/.gates/sessions/`.
