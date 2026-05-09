import { Effect } from "effect";
import type { SkillExecutorConfig, SkillContext, SkillConfig, SkillExecutor } from "./types.js";
import type { Sandbox } from "@gates-effect/sandbox";
import type { Tool } from "@gates-effect/runtime";
import { toolsMap } from "@gates-effect/runtime";

export const createSandboxToolExecutor = (sandbox: Sandbox): SkillExecutorConfig => {
  const tools = toolsMap(sandbox);

  return {
    executeTool: (toolName: string, params: Record<string, unknown>, _context: SkillContext) => {
      const tool = tools.get(toolName);
      if (!tool) {
        return Effect.fail(new Error(`Tool "${toolName}" not found`));
      }
      return Effect.map(tool.execute(params), (result: { isError?: boolean; content: unknown }) => {
        if (result.isError) {
          return { error: String(result.content) } as unknown;
        }
        return result.content;
      });
    },

    executePrompt: (prompt: string, _context: SkillContext) =>
      Effect.succeed(`Executed prompt: ${prompt.substring(0, 50)}...`),

    maxTransitions: 100,
  };
};

export const createLLMAwareExecutor = (
  sandbox: Sandbox,
  agentApiKey?: string,
  delegateSkill?: (
    skillName: string,
    inputs: Record<string, string>,
    context: SkillContext
  ) => Effect.Effect<unknown, Error>
): SkillExecutorConfig => {
  const tools = toolsMap(sandbox);

  return {
    executeTool: (toolName: string, params: Record<string, unknown>, _context: SkillContext) => {
      const tool = tools.get(toolName);
      if (!tool) {
        return Effect.fail(new Error(`Tool "${toolName}" not found`));
      }
      return Effect.map(tool.execute(params), (result: { isError?: boolean; content: unknown }) => {
        if (result.isError) {
          return { error: String(result.content) } as unknown;
        }
        return result.content;
      });
    },

    executePrompt: (prompt: string, context: SkillContext): Effect.Effect<unknown, Error> => {
      const hasLLMContext = prompt.includes("{{methodology}}") ||
                            prompt.includes("{{lastOutput}}") ||
                            prompt.includes("{{inputs.");

      if (hasLLMContext && agentApiKey) {
        return Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: async () => {
              const res = await fetch("https://api.minimax.io/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${agentApiKey}`,
                },
                body: JSON.stringify({
                  model: "MiniMax-M2.7",
                  messages: [{ role: "user", content: prompt }],
                  temperature: 0.7,
                }),
              });
              return res.json() as Promise<{ choices?: Array<{ message?: { content?: string } }> }>;
            },
            catch: (e) => new Error(`LLM call failed: ${e}`),
          });

          const content = response?.choices?.[0]?.message?.content;
          if (!content) return "[LLM] No response content";
          try { return JSON.parse(content); } catch { return content; }
        }).pipe(
          Effect.catch_((e) => Effect.succeed(`[LLM] Error: ${e.message}`))
        );
      }

      return Effect.succeed(`[PROMPT] ${prompt.substring(0, 100)}...`);
    },

    delegateSkill,
    maxTransitions: 100,
  };
};

export const runSkillWithSandbox = async (
  skillConfig: SkillConfig,
  sandbox: Sandbox,
  input: Record<string, unknown>,
  agentApiKey?: string
): Promise<SkillContext> => {
  const executorConfig = createLLMAwareExecutor(sandbox, agentApiKey);
  const { makeSkillExecutor } = await import("./executor.js");
  const executor = await Effect.runPromise(makeSkillExecutor(skillConfig, executorConfig));
  return Effect.runPromise(executor.execute(input));
};

export const createSkillExecutorWithSandbox = async (
  skillConfig: SkillConfig,
  sandbox: Sandbox,
  agentApiKey?: string,
  delegateSkill?: (
    skillName: string,
    inputs: Record<string, string>,
    context: SkillContext
  ) => Effect.Effect<unknown, Error>
): Promise<SkillExecutor> => {
  const executorConfig = createLLMAwareExecutor(sandbox, agentApiKey, delegateSkill);
  const { makeSkillExecutor } = await import("./executor.js");
  return Effect.runPromise(makeSkillExecutor(skillConfig, executorConfig));
};

export const getBuiltInTools = (sandbox: Sandbox): Map<string, Tool> =>
  toolsMap(sandbox);

export const skillToolNames = [
  "read",
  "write",
  "bash",
  "glob",
  "grep",
  "edit",
] as const;

export type SkillToolName = typeof skillToolNames[number];

export const isSkillTool = (name: string): name is SkillToolName =>
  skillToolNames.includes(name as SkillToolName);