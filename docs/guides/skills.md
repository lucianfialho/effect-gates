# Skills

Skills are state machines defined in YAML. Each state is a tool call, an LLM prompt, or a delegation to another skill.

## Minimal skill

```yaml
name: greet
initialState: say_hello

states:
  - id: say_hello
    prompt: "Say hello to {{inputs.name}}."
  - id: done

transitions:
  - from: say_hello
    to: done
```

## States

### Tool state

```yaml
- id: read_file
  tool: read              # tool name from sandbox or connector
  params:
    path: "{{inputs.target}}"
  onSuccess: analyze
  onFail: report_error
```

### Prompt state

```yaml
- id: analyze
  prompt: |
    Analyze this code:
    {{lastOutput}}

    Return JSON: { "issues": [...], "summary": "..." }
```

### Delegate state

```yaml
- id: create_ticket
  delegate_to: create-github-issues
  delegate_inputs:
    title: "{{lastOutput.title}}"
    description: "{{lastOutput.description}}"
```

## Interpolation

| Template | Value |
|---|---|
| `{{inputs.key}}` | Input passed to the skill |
| `{{lastOutput}}` | Full output of the previous state |
| `{{lastOutput.field}}` | Field from a JSON output |
| `{{outputs.field}}` | Alias for `lastOutput.field` |
| `{{metadata.key}}` | Execution metadata |
| `{{methodology.name}}` | Loaded methodology field |
| `{{file:path/to/file.md}}` | File contents injected verbatim |

## Conditionals

```yaml
prompt: |
  Review this code.

  {% if inputs.strict %}
  Apply strict rules. Report every issue.
  {% else %}
  Focus on critical issues only.
  {% endif %}

  {% if context.errors.length > 0 %}
  NOTE: Previous states had errors.
  {% endif %}

  Code: {{lastOutput}}
```

Supported conditions:

```
inputs.key                   truthy check
!inputs.key                  negation
inputs.mode == "fast"        string equality
inputs.count > 3             numeric comparison (>, <, >=, <=)
context.errors.length > 0   context comparisons
lastOutput.status == "ok"   output field check
```

## Transitions

```yaml
transitions:
  - from: analyze
    to: fix
    when: "lastOutput.issues_count > 0"   # conditional

  - from: analyze
    to: done                               # default

  - from: fix
    to: done
    condition: on_fail                     # only if state failed
```

## Guards

```yaml
states:
  - id: process
    guards:
      - if: "inputs.severity == high"
        skipTo: escalate
```

## Running skills

```bash
# CLI
gates skill refactor --input '{"target": "src/auth.ts"}'

# harness-ui chat
/skill refactor target=src/auth.ts

# TypeScript
const executor = yield* makeSkillExecutor(config, executorConfig);
const ctx = yield* executor.execute({ target: "src/auth.ts" });
// ctx.results, ctx.errors, ctx.lastOutput
```

## Discovery

```typescript
import { discoverSkills, loadSkillFromDirectory } from "@gates/skills";

// Discover all skills in .gates/skills/
const skills = yield* discoverSkills(".gates/skills", { recursive: true });

// Load one skill
const skill = yield* loadSkillFromDirectory(".gates/skills/refactor");
```
