# Connector System

Connectors package external CLIs as reusable tools. A connector is a directory inside `.gates/connectors/` containing a `connector.yaml` — no code required.

## Creating a connector

```
.gates/connectors/my-connector/
  connector.yaml
  skills/          (optional — bundled skills)
  docs/            (optional — Markdown context for the LLM)
```

## connector.yaml

```yaml
name: github
description: GitHub via gh CLI
version: "1.0"

requiredCredentials:
  - GH_TOKEN        # warns at load if missing

commands:
  - name: gh
    description: "GitHub CLI — issues, PRs, repos"
    executable: gh
    allowedSubcommands:
      - issue
      - pr
      - repo
      - api
    env:
      GH_TOKEN: "{{credentials.GH_TOKEN}}"

skills:
  - skills/create-issue.yaml    # bundled skill

docs:
  - docs/github-conventions.md  # injected as LLM context
```

## Loading connectors

```typescript
import { loadConnectors } from "@gates-effect/skills";

const registry = yield* loadConnectors(".gates/connectors", {
  GH_TOKEN: process.env.GH_TOKEN!,
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: "~/.gates/google-credentials.json",
});

const allTools = registry.allTools();   // Map<string, Tool>
const allSkills = registry.allSkills(); // SkillConfig[]
const context = registry.allDocs();     // string — inject into prompts
```

## Credential injection

Values in `env` support `{{credentials.KEY}}` — resolved at load time from the credentials map. If a key is missing, the value is an empty string (no crash, no leak from `process.env`).

```yaml
env:
  GH_TOKEN: "{{credentials.GH_TOKEN}}"       # from credentials map
  HOME: ""                                    # always passed (safe baseline)
```

## allowedSubcommands

Restricts the LLM to a whitelist. Any attempt to use a subcommand outside the list returns `toolError` immediately — the process is never spawned.

```yaml
allowedSubcommands: [issue, pr]
# LLM tries: gh push → blocked: "push is not allowed"
# LLM tries: gh issue create → OK
```

## Built-in connectors

| Connector | CLI | Tools |
|---|---|---|
| `google-workspace` | `gws` | `gws_calendar`, `gws_meet`, `gws_drive` |
| `github` | `gh` | `gh` |
| `git` | `git` | `git` |

## When to use tools.js

For CLIs that don't cover all your needs, you can add a `tools.js` to the connector directory. It exports an async factory:

```javascript
// .gates/connectors/my-connector/tools.js
export default async function(credentials) {
  return [
    {
      name: "my_tool",
      description: "Does something",
      parameters: { type: "object", properties: { input: { type: "string" } } },
      execute: async (params) => ({ content: `result: ${params.input}` }),
    },
  ];
}
```

Tools from `tools.js` are merged with `commands` from `connector.yaml`.
