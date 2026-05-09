# gates-effect

Framework para construção de harnesses de agentes de IA usando [Effect](https://effect.website/) v4. Inspirado no [Flue](https://flueframework.com/), aplica o conceito de **atomic gates** — primitivas componíveis e type-safe para orquestrar LLMs, ferramentas e máquinas de estado de skills.

## Estrutura

```
packages/
  gates/      Primitivas atômicas (bash safety, leitura de arquivos, dedup)
  providers/  Integrações com LLMs (MiniMax, Anthropic, OpenAI)
  sandbox/    Execução segura de comandos e arquivos
  runtime/    Agente, sessões, compactação de contexto, harness, eventos
  skills/     Máquina de estados para skills (YAML ou programático)
  wiki/       Base de conhecimento em Markdown com busca
  cli/        Comandos gates run / chat / resume / dev / skill
```

---

## Instalação

```bash
pnpm install
pnpm build
```

---

## `@gates-effect/providers`

Interfaces unificadas para provedores de LLM.

### Tipos principais

```typescript
interface Provider {
  id: string;
  chat(messages: Message[], tools?: Tool[]): Effect.Effect<ChatResponse, ProviderError>;
}

interface Message {
  role: "user" | "assistant" | "system" | "context";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  cost?: number;
  reasoningDetails?: string;
}

interface ToolCall  { id: string; name: string; arguments: string; }
interface ToolResult { toolCallId: string; content: string; isError?: boolean; }
```

### Provedores disponíveis

```typescript
import { makeMiniMaxProvider }  from "@gates-effect/providers";
import { makeAnthropicProvider } from "@gates-effect/providers";
import { makeOpenAIProvider }    from "@gates-effect/providers";

const provider = makeMiniMaxProvider({
  apiKey: process.env.MINIMAX_API_KEY!,
  model: "MiniMax-M2.7",   // opcional
  baseUrl: "...",           // opcional
});
```

---

## `@gates-effect/sandbox`

Execução segura de comandos e operações de arquivo com proteção contra path traversal.

### Interface

```typescript
interface Sandbox {
  run(command: string): Effect.Effect<string, SandboxError>;
  readFile(path: string): Effect.Effect<string, SandboxError>;
  writeFile(path: string, content: string): Effect.Effect<void, SandboxError>;
  listDir(path: string): Effect.Effect<string[], SandboxError>;
  exists(path: string): Effect.Effect<boolean, SandboxError>;
  cwd: string;
}
```

### Criação

```typescript
import { makeSandbox, makeLocalSandbox, makeInMemorySandbox } from "@gates-effect/sandbox";

// Fábrica (escolhe o tipo)
const sandbox = yield* makeSandbox("local", { cwd: "/meu/projeto", timeout: 30000 });
const sandbox = yield* makeSandbox("memory");

// Direto
const local  = yield* makeLocalSandbox({ cwd: process.cwd() });
const memory = yield* makeInMemorySandbox();
```

`makeLocalSandbox` rejeita paths que escapam do `cwd` via `PERMISSION_DENIED`.

### Isolamento de credenciais

Por padrão, `makeLocalSandbox` passa `process.env` inteiro para os processos. Com `isolated: true`, só as chaves de base seguras (`PATH`, `HOME`, `LANG`, etc.) mais as entradas explícitas em `env` e `credentials` são passadas — sem vazamento acidental entre agentes.

```typescript
// Agente A — só acessa GitHub
const sandboxA = yield* makeLocalSandbox({
  isolated: true,
  credentials: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! },
});

// Agente B — só acessa Linear
const sandboxB = yield* makeLocalSandbox({
  isolated: true,
  credentials: { LINEAR_TOKEN: process.env.LINEAR_TOKEN! },
});
// GITHUB_TOKEN nunca chega ao sandboxB
```

`SandboxConfig`:

| Campo | Tipo | Descrição |
|---|---|---|
| `cwd` | string | Diretório de trabalho (default: `process.cwd()`) |
| `timeout` | number | Timeout de comandos em ms (default: 30000) |
| `env` | Record | Variáveis adicionais sobrepostas ao ambiente |
| `credentials` | Record | Secrets do agente — sempre sobrepostos por último |
| `isolated` | boolean | Quando `true`, bloqueia o `process.env` completo |

### Erros

```typescript
SandboxError.FileNotFound(path)
SandboxError.PermissionDenied(path)
SandboxError.CommandFailed(cmd, output)
SandboxError.Timeout(cmd, ms)
```

---

## `@gates-effect/runtime`

Núcleo do framework: agente com sessões, loop de ferramentas, compactação de contexto e harness.

### Agent

```typescript
import { makeAgent } from "@gates-effect/runtime";

const agent = yield* makeAgent({
  model: "MiniMax-M2.7",
  provider,                         // Provider de @gates-effect/providers
  systemPrompt: "Você é...",        // opcional
  temperature: 0.7,                 // opcional
  compactionConfig: {               // opcional
    thresholdTokens: 15000,
    maxEntriesBeforeCompaction: 100,
    budgetAware: true,
    compactionThresholdPercent: 80,
  },
  tokenBudgetConfig: {              // opcional
    maxContextTokens: 128000,
    reservedForResponse: 4000,
    compactionThresholdPercent: 80,
  },
});

// Primeiro turno — cria sessão interna
const r1 = yield* agent.run("Meu nome é Lucian");
console.log(r1.content, r1.session.id);

// Retomar sessão existente
const r2 = yield* agent.resume(r1.session.id, "Qual é meu nome?");

// Histórico completo
const history = yield* agent.getHistory(r1.session.id);

// Orçamento de tokens
const budget = yield* agent.getBudget(r1.session.id);
// { used, budget, reservedForResponse, available, usagePercent }
```

`AgentResponse`:
```typescript
{
  content: string;
  session: { id, createdAt, messages, metadata };
  usage: { inputTokens, outputTokens, totalTokens };
  cost: number;
  compaction?: CompactionResult;
  budget?: TokenBudget;
}
```

### Agent Loop (tool calling manual)

```typescript
import { runAgentLoop } from "@gates-effect/runtime";

const result = yield* runAgentLoop(
  (messages) => provider.chat(messages, tools),  // LLM call
  toolsMap,                                       // Map<string, Tool>
  initialMessages,
  {
    maxIterations: 10,
    toolConcurrency: "sequential",  // ou "unbounded" ou número
  }
);
// result.finalContent, result.allToolCalls, result.didComplete
```

### Ferramentas built-in

```typescript
import { toolsMap, makeReadTool, makeWriteTool, makeBashTool,
         makeGlobTool, makeGrepTool, makeEditTool } from "@gates-effect/runtime";

const tools = toolsMap(sandbox);  // Map<string, Tool> com todas as 6 ferramentas

// Individualmente
const read = makeReadTool(sandbox);  // Tool { name, description, parameters, execute }
```

Ferramentas disponíveis: `read`, `write`, `bash`, `glob`, `grep`, `edit`.

### `defineCommand` — CLIs externas como tools isoladas

`defineCommand` cria uma `Tool` que expõe um executável externo (git, npm, docker…) ao LLM com ambiente completamente isolado. Diferente de `makeBashTool`, que aceita qualquer comando shell, `defineCommand`:

- Roda **apenas o executável declarado** (sem shell intermediário)
- Aceita um **allowlist de subcomandos** — tenta fora → `toolError` imediato
- Passa **somente** `PATH`/`HOME` + as entradas de `env` — `process.env` nunca vaza

```typescript
import { defineCommand } from "@gates-effect/runtime";

const git = defineCommand({
  name: "git",
  description: "Operações git no repositório",
  executable: "git",
  allowedSubcommands: ["status", "log", "diff", "add", "commit", "push", "pull"],
  baseArgs: ["--no-pager"],       // prefixados a todo comando
  env: {
    GIT_AUTHOR_NAME: "Agent",
    GIT_AUTHOR_EMAIL: "agent@local",
  },
  cwd: process.cwd(),
  timeout: 30000,
});

// O LLM chama com: { args: "log --oneline -5" }
// Executa: git --no-pager log --oneline -5

// Subcommand bloqueado:
// { args: "push --force" } → toolError: "push" is not allowed
```

`CommandConfig`:

| Campo | Tipo | Descrição |
|---|---|---|
| `name` | string | Nome da tool como o LLM a vê |
| `executable` | string | Binário a executar (`git`, `npm`, `gh`) |
| `allowedSubcommands` | string[] | Primeiro argumento permitido — bloqueia o resto |
| `baseArgs` | string[] | Args sempre prefixados antes dos do LLM |
| `env` | Record | Env vars disponíveis (isolado de `process.env`) |
| `cwd` | string | Diretório de trabalho |
| `timeout` | number | Timeout em ms (default: 30000) |

### Sessões com persistência em arquivo

```typescript
import { makeFileSessionStore, SessionHistory, listSessions } from "@gates-effect/runtime";

const store = yield* makeFileSessionStore();
// Salva em ~/.gates/sessions/<key>.json

// Salvar
yield* store.save("chat:minha-sessao", data);

// Carregar
const data = yield* store.load("chat:minha-sessao");  // null se não existe

// Listar
const ids = yield* listSessions();

// Reconstruir histórico
const history = yield* SessionHistory.fromData(data);
const messages = yield* history.buildContext();
```

### SessionHistory

```typescript
const history = yield* SessionHistory.empty();
// ou
const history = yield* SessionHistory.fromData(savedData);

yield* history.appendMessage(message, "user" | "prompt" | "skill" | "shell");
yield* history.appendBranchSummary(fromId, summary);

const messages = yield* history.buildContext();  // Message[] com compactações aplicadas
const tokens   = yield* history.getTotalTokens();
const data     = yield* history.toData({ sessionId });  // serializar
```

### Harness (alto nível)

```typescript
import { createHarness, skill, role } from "@gates-effect/runtime";
import type { CompactionScope } from "@gates-effect/runtime";

const harness = createHarness({
  provider,
  roles: [
    role("engenheiro", "Você é um engenheiro sênior de software.", {
      model: "MiniMax-M2.7",
      compaction: { maxContextTokens: 12000, thresholdPercent: 75 },
    }),
    role("revisor", "Você é um revisor de código criterioso."),
  ],
  skills: new Map([
    ["analise", {
      name: "analise",
      description: "Analisa código",
      execute: (args, session) =>
        session.prompt(`Analise este código: ${args.code}`).pipe(
          Effect.map((r) => r.content)
        ),
    }],
  ]),
});

// Cada init() cria uma sessão com histórico independente
const session = yield* harness.init({ role: "engenheiro" });

const r1 = yield* session.prompt("Olá, me fale sobre SOLID");
const r2 = yield* session.prompt("Dê um exemplo do SRP");  // lembra o turno anterior

const resultado = yield* session.skill("analise", {
  args: { code: "class Foo { ... }" },
  result: { parse: (r) => Effect.succeed(r) },
});
```

### Compactação por escopo no Harness

O Harness suporta compactação automática de histórico em três escopos com prioridade **call > role > nenhum**.

Quando o histórico estimado ultrapassa o threshold, o LLM é chamado para resumir as mensagens mais antigas. O `historyRef` é atualizado com `[summaryMessage, ...recentMessages]`.

**`CompactionScope`:**

| Campo | Default | Descrição |
|---|---|---|
| `maxContextTokens` | 8000 | Limite em tokens estimados que dispara |
| `thresholdPercent` | 80 | % do limite necessária para disparar (0–100) |
| `keepRecentMessages` | 4 | Mensagens recentes mantidas verbatim após o resumo |

```typescript
// Nível de role — aplica em todos os prompts dessa role
role("analista", "Você analisa repositórios.", {
  compaction: {
    maxContextTokens: 8000,
    thresholdPercent: 75,
    keepRecentMessages: 4,
  },
})

// Nível de chamada — só neste prompt (sobrescreve o role)
yield* session.prompt("analise estes arquivos", {
  compaction: { maxContextTokens: 4000, keepRecentMessages: 2 },
})

// Desabilitar para uma chamada específica, mesmo com compaction no role
yield* session.prompt("resposta rápida", { compaction: false })
```

Se a chamada de sumarização falhar, o histórico original é mantido sem erro.

### Compactação de contexto (nível de Agent)

Compactação automática baseada em orçamento de tokens para o `makeAgent`. Disparada quando `usagePercent` ou contagem de entradas ultrapassa os thresholds configurados no `AgentConfig.compactionConfig`.

```typescript
import { runCompaction, createCompactionTrigger, withCompaction } from "@gates-effect/runtime";

// Trigger baseado em orçamento ou contagem de entradas
const trigger = createCompactionTrigger(config, budgetTracker);
const { shouldCompact, triggeredBy } = yield* trigger.trigger(tokens, entryCount);

// Compactar via LLM
const result = yield* runCompaction(history, { modelId, provider, triggeredBy });
// result: { compacted, tokensBefore, tokensAfter, summary, triggeredBy }
```

> Para compactação no Harness com granularidade por role ou por chamada, ver **Compactação por escopo no Harness** acima.

### Eventos e telemetria

```typescript
import { makeAgentEvents, createTelemetryPlugin, withTelemetry } from "@gates-effect/runtime";

const events = yield* makeAgentEvents();
yield* events.publish({ type: "agent_start", timestamp: Date.now() });
const stream = events.getStream();  // Stream<AgentEvent>

// Telemetria
const plugin = createTelemetryPlugin("meu-plugin", {
  onEvent: (e) => console.log(e.type, e.timestamp),
  onError: (err, e) => console.error(err),
});

const resultado = yield* withTelemetry(meuEffect, [plugin]);
// emite agent_start no início e agent_end / error ao final (sucesso ou falha)
```

### SSE (Server-Sent Events)

```typescript
import { eventsToSSEStream, createSSEStream, eventToSSELines } from "@gates-effect/runtime";

const sseStream = createSSEStream(events);  // Stream<string>
// Cada elemento: "event: agent_start\ndata: {...}\n\n"
```

---

## `@gates-effect/skills`

Máquinas de estado para skills — YAML ou programático.

### YAML de skill

```yaml
name: refactor
description: Refatora código seguindo uma metodologia
initialState: read

states:
  - id: read
    tool: read                        # usa a tool "read" do sandbox
    params:
      path: "{{inputs.target}}"       # interpolação de inputs

  - id: analyze
    prompt: |                         # envia ao LLM
      Analise este código:
      {{lastOutput}}                  # output do estado anterior
      Retorne JSON com os problemas.

  - id: fix
    tool: write
    params:
      path: "{{inputs.target}}"
      content: "{{lastOutput.fixed}}" # campo do JSON anterior
    onSuccess: done
    onFail: report_error

  - id: done
  - id: report_error

transitions:
  - from: read
    to: analyze
  - from: analyze
    to: fix
    when: "output.issues_count > 0"   # condicional
  - from: analyze
    to: done
```

**Interpolações disponíveis em `prompt` e `params`:**

| Template | Descrição |
|---|---|
| `{{inputs.key}}` | Input passado ao skill |
| `{{lastOutput}}` | Output completo do estado anterior |
| `{{lastOutput.campo}}` | Campo de um JSON no lastOutput |
| `{{outputs.campo}}` | Alias de `lastOutput.campo` |
| `{{methodology.name}}` | Campo de uma metodologia carregada |
| `{{metadata.key}}` | Campo dos metadados do contexto |
| `{{file:caminho/arquivo.md}}` | Conteúdo de um arquivo injetado literalmente |

**`{{file:...}}` — injeção de arquivos:**

O caminho é relativo ao `basePath` do executor (default: `process.cwd()`) ou absoluto. Arquivo não encontrado produz `[file not found: caminho]` em vez de falhar.

```yaml
states:
  - id: analyze
    prompt: |
      {{file:.gates/prompts/refactor-header.md}}

      Analise o código abaixo seguindo as regras acima:
      {{lastOutput}}

      Target: {{inputs.target}}
```

**`{% if %}`/`{% else %}`/`{% endif %}` — blocos condicionais:**

Processados antes das interpolações, suportam nesting arbitrário. Sem `eval` ou `new Function` — expressões seguras.

```yaml
states:
  - id: review
    prompt: |
      Revise este código.

      {% if inputs.mode == "strict" %}
      Seja rigoroso. Aponte TODOS os problemas, mesmo os menores.
      {% else %}
      Foque apenas nos problemas críticos e de segurança.
      {% endif %}

      {% if context.errors.length > 0 %}
      ATENÇÃO: ocorreram erros nos estados anteriores.
      {% endif %}

      {% if inputs.verbose %}
      Explique o raciocínio de cada decisão em detalhe.
      {% endif %}

      Código: {{lastOutput}}
```

**Condições suportadas em `{% if %}`:**

| Expressão | Descrição |
|---|---|
| `inputs.key` | Verdadeiro se o valor é truthy |
| `!inputs.key` / `not inputs.key` | Negação |
| `inputs.key == "valor"` | Igualdade de string |
| `inputs.key != "valor"` | Desigualdade de string |
| `inputs.count > 3` | Comparação numérica (`>`, `<`, `>=`, `<=`) |
| `context.errors.length > 0` | Condição sobre o contexto de execução |
| `context.results.length >= 2` | Número de resultados acumulados |
| `lastOutput.status == "ok"` | Campo de um JSON do output anterior |

**Campos de estado:**

| Campo | Tipo | Descrição |
|---|---|---|
| `tool` | string | Nome da tool do sandbox a executar |
| `prompt` | string | Prompt enviado ao LLM |
| `delegate_to` | string | Delega para outro skill pelo nome |
| `delegate_inputs` | map | Inputs para o skill delegado |
| `params` | map | Parâmetros da tool ou prompt |
| `onSuccess` | string | Estado destino se sucesso |
| `onFail` | string | Estado destino se falha |
| `timeout` | number | Timeout em ms (default 60000) |
| `guards` | list | Condições de guarda |

**Transitions:**

| Campo | Descrição |
|---|---|
| `from` / `to` | Estados origem e destino |
| `when` | `output.campo == 'valor'` — avalia o último output |
| `condition` | `on_fail` — só transiciona se o estado falhou |
| `guard.if` | `severity == high`, `error`, `success`, `tests_failed` |

### API programática

```typescript
import { makeSkillExecutor, validateSkillConfig } from "@gates-effect/skills";

const errors = validateSkillConfig(config);  // SkillError[]

const executor = yield* makeSkillExecutor(config, {
  executeTool: (name, params, ctx) => Effect.succeed(...),
  executePrompt: (prompt, ctx)     => Effect.succeed(...),
  delegateSkill: (name, inputs, ctx) => Effect.succeed(...),
  maxTransitions: 100,
});

const ctx = yield* executor.execute({ target: "src/foo.ts" });
// ctx.results  — Array<{ state, output, timestamp }>
// ctx.errors   — Array<{ state, error, timestamp }>
// ctx.state    — estado final
// ctx.lastOutput — último output

const events = yield* executor.getEvents();  // SkillEvent[]
yield* executor.abort();
```

`executor.execute` falha com `SkillError` se o estado não existe ou se as max transitions forem atingidas. Falhas recuperáveis (com `onFail` configurado) ficam em `ctx.errors`.

### Descoberta de skills

```typescript
import { discoverSkills, loadSkillFromDirectory } from "@gates-effect/skills";

const skills = yield* discoverSkills(".gates/skills", { recursive: true, maxDepth: 3 });
// skills[].config, skills[].path, skills[].files.skillMd

const skill = yield* loadSkillFromDirectory(".gates/skills/refactor");
```

### Executor com sandbox

```typescript
import { createSandboxToolExecutor, createLLMAwareExecutor,
         createSkillExecutorWithSandbox } from "@gates-effect/skills";

// Só ferramentas (sem LLM nos prompts)
const config = createSandboxToolExecutor(sandbox);

// Ferramentas + LLM para estados com prompt
const config = createLLMAwareExecutor(sandbox, apiKey, delegateSkillFn);

// Atalho completo
const executor = await createSkillExecutorWithSandbox(skillConfig, sandbox, apiKey);
```

### SkillRunner (registro programático)

```typescript
import { makeSkillRunner } from "@gates-effect/skills";

const runner = yield* makeSkillRunner();

yield* runner.register({
  name: "saudacao",
  description: "Diz olá",
  execute: (input) => Effect.succeed({ result: `Olá, ${input.params.nome}!` }),
});

const output = yield* runner.run("saudacao", {
  params: { nome: "Lucian" },
  context: { workingDirectory: ".", environment: {}, sessionId: "x" },
});
```

### Metodologias

```yaml
# .gates/methodologies/solid.yaml
name: SOLID Principles
description: Cinco princípios de design OO
version: "1.0"

rules:
  - id: srp
    name: Single Responsibility Principle
    description: Uma classe deve ter apenas uma razão para mudar
    examples:
      - before: "class UserManager { save(); sendEmail(); generateReport() }"
        after:  "class UserRepo { save }; class EmailSvc { send }; ..."
    patterns:
      - "class com 5+ métodos de responsabilidades diferentes"

guardrails:
  - id: no-god-classes
    description: Nenhuma classe deve exceder 200 linhas

evaluation:
  heuristics:
    - rule: srp
      check: "Cada classe tem no máximo uma razão para mudar?"
```

```typescript
import { loadMethodology, formatMethodologyForPrompt } from "@gates-effect/skills";

const m = yield* loadMethodology("solid");           // carrega de .gates/methodologies/solid.yaml
const texto = formatMethodologyForPrompt(m);         // formata para injetar em um prompt
```

### Connector system

Connectors empacotam CLIs externas (via `defineCommand`), skills e documentação numa unidade instalável. Ficam em `.gates/connectors/<nome>/` e são carregados automaticamente com suas credenciais.

#### Estrutura de um connector

```
.gates/connectors/github/
  connector.yaml        ← manifesto declarativo
  skills/
    criar-pr.yaml       ← skills bundled com o connector
  docs/
    workflow.md         ← documentação injetável em prompts
```

#### `connector.yaml`

```yaml
name: github
description: Integração com GitHub via gh CLI
version: "1.0"

requiredCredentials:
  - GH_TOKEN            # avisa no console se faltar

commands:
  - name: gh
    description: "GitHub CLI — PRs, issues, repos"
    executable: gh
    allowedSubcommands:
      - pr
      - issue
      - repo
      - api
      - release
    env:
      GH_TOKEN: "{{credentials.GH_TOKEN}}"   # injeção de credencial

  - name: git
    description: "Git operations"
    executable: git
    allowedSubcommands:
      - status
      - log
      - diff
      - add
      - commit
      - push
      - pull
    baseArgs:
      - "--no-pager"

skills:
  - skills/criar-pr.yaml

docs:
  - docs/workflow.md
```

`{{credentials.KEY}}` é resolvido no carregamento com as credenciais passadas. Chave ausente → string vazia (não falha).

#### API

```typescript
import { loadConnectors, loadConnector } from "@gates-effect/skills";

// Carregar todos os connectors de um diretório
const registry = yield* loadConnectors(".gates/connectors", {
  GH_TOKEN: process.env.GH_TOKEN!,
  GIT_AUTHOR_NAME: "Lucian",
});

// registry.connectors              — Map<string, Connector>
// registry.allTools()              — Map<string, Tool> (todas as tools)
// registry.allSkills()             — SkillConfig[] (todas as skills)
// registry.allDocs()               — string com docs concatenadas para contexto

// Carregar um connector específico
const connector = yield* loadConnector(".gates/connectors/github", credentials);
// connector.tools, connector.skills, connector.docs, connector.missingCredentials
```

#### Combinando com toolsMap

```typescript
import { toolsMap } from "@gates-effect/runtime";
import { loadConnectors } from "@gates-effect/skills";

const sandbox = yield* makeSandbox("local", { isolated: true });
const registry = yield* loadConnectors(".gates/connectors", credentials);

// Merge: sandbox tools + connector tools
const allTools = new Map([
  ...toolsMap(sandbox),
  ...registry.allTools(),
]);

// Injetar docs dos connectors no system prompt
const systemPrompt = `Você é um assistente de desenvolvimento.\n\n${registry.allDocs()}`;
```

#### `Connector`

| Campo | Tipo | Descrição |
|---|---|---|
| `name` | string | Nome do connector |
| `tools` | `Tool[]` | Tools geradas dos `commands` |
| `skills` | `SkillConfig[]` | Skills bundled |
| `docs` | string | Docs concatenadas |
| `missingCredentials` | string[] | Credenciais declaradas mas não fornecidas |

---

## `@gates-effect/gates`

Primitivas atômicas de baixo nível.

### Bash safety

```typescript
import { bashSafety, runBash } from "@gates-effect/gates";

// Validar apenas
const check = bashSafety({ allowedPaths: ["/tmp"] });
yield* check("git status");  // ok
yield* check("rm -rf /");    // BashSafetyError("DANGEROUS_PATTERN")

// Validar e executar
const { stdout, stderr } = yield* runBash("git log --oneline -5");
```

Padrões bloqueados: `rm -rf`, `dd`, `mkfs`, `chmod 777`, `chown`, fork bomb, `| sh`.
Comandos permitidos: `ls`, `cat`, `grep`, `find`, `echo`, `pwd`, `git`, `npm`, `pnpm`, `node`, `python`, `cargo`, entre outros.

### Leitura de arquivos grandes

```typescript
import { readLarge } from "@gates-effect/gates";

const content = yield* readLarge("/caminho/arquivo.log", {
  chunkSize: 64 * 1024,   // default: 64KB
  encoding: "utf-8",
});
```

### Deduplicação de linhas

```typescript
import { dedupLines, dedupSimilar } from "@gates-effect/gates";

// Deduplicação exata (ou com comparador customizado)
const unique = yield* dedupLines(lines);
const unique = yield* dedupLines(lines, { comparator: (a, b) => a.trim() === b.trim() });

// Deduplicação por similaridade (Levenshtein)
const unique = yield* dedupSimilar(lines, 0.8);  // threshold 0–1
```

### Metadados de arquivo/diretório

```typescript
import { getFileMetadata, getDirectoryMetadata } from "@gates-effect/gates";

const meta = yield* getFileMetadata("/caminho/arquivo.ts");
// { path, size, created, modified, accessed, isFile, isDirectory, permissions: "rwxr-xr-x" }

const dir = yield* getDirectoryMetadata("/caminho/dir", { recursive: true, maxDepth: 3 });
// { path, fileCount, directoryCount, totalSize, files: FileMetadata[] }
```

---

## `@gates-effect/wiki`

Base de conhecimento em Markdown com frontmatter YAML e busca de texto.

```typescript
import { loadWikiIndex, getEntry, saveEntry, searchWiki } from "@gates-effect/wiki";

// Carregar índice
const index = yield* loadWikiIndex(".");
// { entries: WikiEntry[], totalEntries, lastUpdated }

// Ler entrada
const entry = yield* getEntry("arquitetura/visao-geral.md");
// { path, title, content, tags: string[], created, modified }

// Salvar entrada (cria .gates/wiki/<path>)
yield* saveEntry({
  path: "decisoes/usar-effect.md",
  title: "Por que Effect",
  content: "Porque...",
  tags: ["effect", "decisão"],
  created: Date.now(),
  modified: Date.now(),
});

// Busca por texto em título, conteúdo e tags
const resultados = yield* searchWiki("effect", ".");
```

---

## CLI

```bash
# Um turno
gates run "explique o padrão Strategy" --provider minimax

# Dev mode com tools (read/write/bash/glob/grep/edit)
gates dev "liste os arquivos e diga quantos têm mais de 100 linhas" --max-iterations 5

# Chat interativo com histórico persistente
gates chat --session meu-projeto --provider minimax

# Retomar sessão existente
gates resume meu-projeto "o que discutimos sobre arquitetura?"

# Rodar skill YAML
gates skill refactor --input '{"target": "src/foo.ts"}' --sandbox local

# Listar sessões salvas
gates sessions
```

**Configuração de API keys** (`~/.gates/config.json`):

```bash
gates login --provider minimax --key sk-...
gates connect   # wizard interativo
```

---

## Executando no Effect

Todos os efeitos precisam ser executados no ponto de entrada:

```typescript
import { Effect } from "effect";

// Em produção
Effect.runPromise(programa).catch(console.error);

// Em testes / scripts
Effect.runSync(programaSincrono);
```

---

## Estrutura de um projeto

```
.gates/
  methodologies/
    solid.yaml
    object-calisthenics.yaml
  skills/
    meu-skill/
      skill.yaml
      SKILL.md           # documentação opcional
      schemas/           # schemas JSON opcionais
  connectors/
    github/
      connector.yaml     # manifesto: commands, skills, docs, requiredCredentials
      skills/
        criar-pr.yaml
      docs/
        workflow.md
    linear/
      connector.yaml
  wiki/
    index.json
    decisoes/
      *.md
  sessions/              # sessões persistidas pelo FileSessionStore
  config.json            # API keys
```
