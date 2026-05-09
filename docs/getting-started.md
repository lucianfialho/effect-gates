# Getting Started

## Install

```bash
# Full monorepo (development)
git clone https://github.com/lucianfialho/effect-gates
cd effect-gates
pnpm install && pnpm build

# Individual packages (production)
pnpm add @gates-effect/runtime @gates-effect/providers @gates-effect/sandbox
```

## Your first agent

```typescript
import { makeAgent } from "@gates-effect/runtime";
import { makeMiniMaxProvider } from "@gates-effect/providers";
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const provider = makeMiniMaxProvider({
    apiKey: process.env.MINIMAX_API_KEY!,
  });

  const agent = yield* makeAgent({
    model: "MiniMax-M2.7",
    provider,
    systemPrompt: "You are a helpful engineering assistant.",
  });

  const response = yield* agent.run("Explain what Effect is in one sentence.");
  console.log(response.content);
});

Effect.runPromise(program).catch(console.error);
```

## API keys

Set environment variables for your provider:

```bash
export MINIMAX_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
```

Or save them via the CLI:

```bash
gates login --provider minimax --key sk-...
```

## Your first skill

Create `.gates/skills/hello/skill.yaml`:

```yaml
name: hello
initialState: greet

states:
  - id: greet
    prompt: "Say hello to {{inputs.name}} in a creative way."
  - id: done

transitions:
  - from: greet
    to: done
```

Run it:

```bash
gates skill hello --input '{"name": "Lucian"}'
```

## Terminal UI

```bash
# Create a harness
mkdir -p .gates/harnesses/my-agent
cat > .gates/harnesses/my-agent/harness.js << 'EOF'
export default {
  name: "My Agent",
  description: "My first harness",
  provider: { type: "minimax" },
  systemPrompt: "You are a helpful assistant.",
  tools: ["read", "bash", "grep"],
};
EOF

# Start
harness-ui
```

## Next steps

- [Architecture overview](architecture.md)
- [Building a harness](guides/building-a-harness.md)
- [Creating skills](guides/skills.md)
- [Connector system](guides/connectors.md)
