import { Effect, Layer, Context } from "effect";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { makeMiniMaxProvider } from "@gates-effect/providers/minimax";
import { makeAnthropicProvider } from "@gates-effect/providers/anthropic";
import { makeOpenAIProvider } from "@gates-effect/providers/openai";
import type { Provider } from "@gates-effect/providers";

export type ProviderType = "minimax" | "anthropic" | "openai";

export interface ProviderConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

export class ProviderService extends Context.Tag("ProviderService")<ProviderService, {
  readonly getProvider: (type: ProviderType) => Provider;
  readonly apiKey: string;
}>() {}

const CONFIG_FILE = path.join(os.homedir(), ".gates", "config.json");

interface Config {
  providers: Record<string, { apiKey?: string; model?: string }>;
}

const readConfig = (): Config => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { providers: {} };
  }
};

export const makeProviderLayer = (config: ProviderConfig): Layer.Layer<ProviderService> =>
  Layer.effect(
    ProviderService,
    Effect.sync(() => ({
      apiKey: config.apiKey,
      getProvider: (type: ProviderType): Provider => {
        const apiKey = config.apiKey;
        switch (type) {
          case "minimax":
            return makeMiniMaxProvider({
              apiKey,
              model: config.model,
              baseUrl: config.baseUrl,
            });
          case "anthropic":
            return makeAnthropicProvider({
              apiKey,
              model: config.model,
              baseUrl: config.baseUrl,
            });
          case "openai":
            return makeOpenAIProvider({
              apiKey,
              model: config.model,
              baseUrl: config.baseUrl,
            });
        }
      },
    }))
  );

export const getProviderConfig = (provider: ProviderType): { apiKey: string | null; model: string | undefined } => {
  const envVar = `${provider.toUpperCase()}_API_KEY`;
  const envKey = process.env[envVar];
  const config = readConfig();
  const providerConfig = config.providers[provider];

  return {
    apiKey: envKey ?? providerConfig?.apiKey ?? null,
    model: providerConfig?.model,
  };
};

export const getApiKey = (provider: ProviderType): string | null => {
  return getProviderConfig(provider).apiKey;
};

export const requireApiKey = (provider: ProviderType): Effect.Effect<string, { message: string }> => {
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    return Effect.fail({
      message: `Missing ${provider.toUpperCase()}_API_KEY. Run 'gates login ${provider}' first.`,
    });
  }
  return Effect.succeed(apiKey);
};