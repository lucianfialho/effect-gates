import { Effect } from "effect";
import {
  createHarness,
  runHarness,
  type FunctionalHarnessDef,
  type HarnessConfig,
  type HarnessError,
  type HarnessRegistry,
} from "./harness.js";

interface RegistryEntry {
  readonly def: FunctionalHarnessDef;
  readonly config: HarnessConfig;
}

/**
 * Registry for named harnesses. Allows one harness to spawn another via
 * ctx.harness('other-name', payload).
 *
 * @example
 * const registry = createHarnessRegistry();
 *
 * registry.register('planner', plannerHarness, config);
 * registry.register('executor', executorHarness, config);
 *
 * // Run the top-level harness
 * await Effect.runPromise(registry.run('planner', { task: '...' }, env));
 */
export const createHarnessRegistry = (): HarnessRegistry & {
  register: (name: string, def: FunctionalHarnessDef, config: HarnessConfig) => void;
  list: () => string[];
} => {
  const entries = new Map<string, RegistryEntry>();

  const self = {
    register(name: string, def: FunctionalHarnessDef, config: HarnessConfig): void {
      entries.set(name, { def, config });
    },

    list(): string[] {
      return Array.from(entries.keys());
    },

    run<P>(name: string, payload: P, env: Record<string, string>): Effect.Effect<unknown, HarnessError> {
      return Effect.gen(function* () {
        const entry = entries.get(name);
        if (!entry) {
          return yield* Effect.fail<HarnessError>({
            code: "HARNESS_NOT_FOUND",
            message: `Harness "${name}" not found. Registered: [${Array.from(entries.keys()).join(", ")}]`,
          });
        }
        return yield* runHarness(entry.def as FunctionalHarnessDef<P, Record<string, string>>, payload, env, entry.config, self);
      });
    },
  };

  return self;
};
