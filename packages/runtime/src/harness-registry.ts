import { Effect } from "effect";
import type { Provider, ProviderError } from "@gatesai/providers";
import {
  createHarness,
  runHarness,
  type FunctionalHarnessDef,
  type HarnessConfig,
  type HarnessError,
  type HarnessRegistry,
  type HarnessStreamEvent,
  type Role,
  type SkillDefinition,
} from "./harness.js";
import type { Message } from "./session-history.js";
import type { Tool } from "./tools.js";

// ── Registry config ────────────────────────────────────────────────────────────

export interface RegistryConfig {
  /** Provider from @gatesai/providers — makeAnthropicProvider, makeOpenAIProvider, etc. */
  readonly provider: Provider;
  /** Extra tools available to all sessions (merged with per-session tools). */
  readonly tools?: Map<string, Tool>;
  /** Skills available to session.skill(). Loaded from @gatesai/skills or defined inline. */
  readonly skills?: Map<string, SkillDefinition>;
  /**
   * Text appended to every role's system prompt.
   * Pass connectorRegistry.allDocs() here for connector documentation.
   */
  readonly systemPromptSuffix?: string;
  readonly maxToolIterations?: number;
  readonly roles?: Role[];
}

// ── Internal helpers ───────────────────────────────────────────────────────────

const bridgeProvider = (provider: Provider): HarnessConfig["provider"] => ({
  chat: (messages, toolDefs, onEvent) =>
    Effect.mapError(
      provider.chat(
        messages as Parameters<Provider["chat"]>[0],
        toolDefs as Parameters<Provider["chat"]>[1],
        onEvent as Parameters<Provider["chat"]>[2],
      ),
      (e: ProviderError) => ({ code: e.code, message: e.message }) satisfies HarnessError
    ) as ReturnType<HarnessConfig["provider"]["chat"]>,
});

const buildHarnessConfig = (config: RegistryConfig): HarnessConfig => {
  const suffix = config.systemPromptSuffix ? `\n\n${config.systemPromptSuffix}` : "";

  const defaultRole: Role = {
    name: "default",
    systemPrompt: `You are a helpful assistant.${suffix}`,
  };

  const roles: Role[] = [
    defaultRole,
    ...(config.roles ?? []).map((r) => ({
      ...r,
      systemPrompt: r.systemPrompt + suffix,
    })),
  ];

  return {
    provider: bridgeProvider(config.provider),
    tools: config.tools,
    skills: config.skills,
    maxToolIterations: config.maxToolIterations ?? 15,
    roles,
  };
};

// ── createHarnessRegistry ──────────────────────────────────────────────────────

/**
 * Creates a registry of named harnesses sharing a common provider + tools.
 *
 * @example
 * // In run.ts:
 * const connectors = yield* loadConnectors(".gates/connectors");
 *
 * const registry = createHarnessRegistry({
 *   provider: makeAnthropicProvider({ apiKey: process.env["ANTHROPIC_API_KEY"]! }),
 *   tools: connectors.allTools(),
 *   systemPromptSuffix: connectors.allDocs(),
 * });
 *
 * registry.register("planner", plannerHarness);
 * registry.register("issue-creator", issueCreatorHarness);
 *
 * yield* registry.run("planner", { transcript: "..." }, { GITHUB_TOKEN: "..." });
 */
export const createHarnessRegistry = (
  config: RegistryConfig
): HarnessRegistry & {
  register: (name: string, def: FunctionalHarnessDef) => void;
  list: () => string[];
} => {
  const harnessConfig = buildHarnessConfig(config);
  const entries = new Map<string, FunctionalHarnessDef>();

  const self = {
    register(name: string, def: FunctionalHarnessDef): void {
      entries.set(name, def);
    },

    list(): string[] {
      return Array.from(entries.keys());
    },

    run<P>(
      name: string,
      payload: P,
      env: Record<string, string>,
      options?: {
        onEvent?: (event: HarnessStreamEvent) => void;
        initialHistory?: Message[];
      }
    ): Effect.Effect<unknown, HarnessError> {
      return Effect.gen(function* () {
        const def = entries.get(name);
        if (!def) {
          return yield* Effect.fail<HarnessError>({
            code: "HARNESS_NOT_FOUND",
            message: `Harness "${name}" not found. Registered: [${Array.from(entries.keys()).join(", ")}]`,
          });
        }
        return yield* runHarness(def as FunctionalHarnessDef<P, Record<string, string>>, payload, env, harnessConfig, self, options);
      });
    },
  };

  return self;
};
