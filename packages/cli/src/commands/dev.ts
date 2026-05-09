import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import { getProviderConfig, type ProviderType } from "../providers/index.js";
import { makeMiniMaxProvider, makeAnthropicProvider, makeOpenAIProvider } from "@gates-effect/providers";
import type { Provider, Message as ProviderMessage } from "@gates-effect/providers";
import { type Message } from "@gates-effect/runtime";

interface DevOptions {
  watch?: string;
  provider: ProviderType;
  model?: string;
  maxIterations?: number;
}

const createProvider = (providerName: ProviderType, apiKey: string, model?: string): Provider => {
  switch (providerName) {
    case "minimax":
      return makeMiniMaxProvider({ apiKey, model });
    case "anthropic":
      return makeAnthropicProvider({ apiKey, model });
    case "openai":
      return makeOpenAIProvider({ apiKey, model });
  }
};

const toProviderMessage = (msg: Message): ProviderMessage => ({
  role: msg.role as "user" | "assistant" | "system" | "context",
  content: msg.content,
  timestamp: msg.timestamp,
});

interface WatchState {
  running: boolean;
  debounceTimer: NodeJS.Timeout | null;
}

const watchPatterns = (patterns: string[], onChange: () => void, state: WatchState): void => {
  console.log(`\n👀 Watching for changes:`);
  for (const p of patterns) {
    console.log(`   - ${p}`);
  }
  console.log("   Press Ctrl+C to stop\n");

  const watchers: fs.FSWatcher[] = [];

  for (const pattern of patterns) {
    const dir = pattern.includes("*") ? pattern.split("*")[0] || "." : pattern;
    const basename = path.basename(pattern);

    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        if (!filename) return;

        const matches = basename === "*" || filename === basename || filename.match(new RegExp("^" + basename.replace("*", ".*") + "$"));

        if (matches && !state.running) {
          if (state.debounceTimer) {
            clearTimeout(state.debounceTimer);
          }
          state.debounceTimer = setTimeout(() => {
            state.running = false;
            onChange();
          }, 300);
        }
      });
      watchers.push(watcher);
      console.log(`   Watching: ${dir} (${basename})`);
    } catch (e) {
      console.error(`   Failed to watch ${pattern}: ${e}`);
    }
  }

  process.on("SIGINT", () => {
    console.log("\n\n👋 Stopping watch mode...");
    watchers.forEach((w) => w.close());
    process.exit(0);
  });
};

const runDev = (prompt: string, provider: Provider) =>
  Effect.gen(function* () {
    const messages: ProviderMessage[] = [
      { role: "user", content: prompt, timestamp: Date.now() }
    ];

    const response = yield* provider.chat(messages);
    return response.content;
  });

const doDev = (prompt: string, options: DevOptions): void => {
  const { apiKey, model: configModel } = getProviderConfig(options.provider);

  if (!apiKey) {
    console.error(`Missing API key. Run 'gates connect' first.`);
    return;
  }

  const model = options.model ?? configModel;
  const provider = createProvider(options.provider, apiKey, model);

  console.log(`\n🚀 Gates Dev Mode`);
  console.log(`Provider: ${options.provider} (${model})`);
  console.log(`Prompt: "${prompt}"`);
  console.log("─".repeat(40));

  const state: WatchState = { running: false, debounceTimer: null };

  const execute = () => {
    state.running = true;
    console.log("\n🔄 Running...\n");

    Effect.runPromise(runDev(prompt, provider)).then(
      (result) => {
        console.log(`📤 Output:\n${result}`);
        state.running = false;
      },
      (e: unknown) => {
        const err = e as { message?: string };
        console.error(`\n❌ Error: ${err.message ?? String(e)}`);
        state.running = false;
      }
    );
  };

  execute();

  if (options.watch) {
    const patterns = options.watch.split(",").map((p) => p.trim());
    watchPatterns(patterns, execute, state);
  }
};

export const dev = (prompt: string, options: DevOptions): void => {
  doDev(prompt, options);
};