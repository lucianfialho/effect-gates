import { Effect, Duration } from "effect";
import type { Provider, ProviderError } from "./types.js";

// ── Rate limit detection ───────────────────────────────────────────────────

const isRateLimit = (e: ProviderError): boolean =>
  e.message.includes("429") || e.message.toLowerCase().includes("rate limit");

// ── Retry with exponential backoff ─────────────────────────────────────────

const retryOn429 = <A>(
  effect: Effect.Effect<A, ProviderError>,
  maxRetries = 5
): Effect.Effect<A, ProviderError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = yield* Effect.result(effect) as Effect.Effect<{ _tag: "Success"; success: A } | { _tag: "Failure"; failure: ProviderError }>;
      if (result._tag === "Success") return result.success;
      if (!isRateLimit(result.failure) || attempt === maxRetries) {
        return yield* Effect.fail(result.failure);
      }
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s + up to 1s jitter
      const base = Math.min(2000 * Math.pow(2, attempt), 32000);
      const jitter = Math.random() * 1000;
      const delay = base + jitter;
      console.warn(`[pacing] rate limited — retry ${attempt + 1}/${maxRetries} in ${(delay / 1000).toFixed(1)}s`);
      yield* Effect.sleep(Duration.millis(delay));
    }
    return yield* Effect.fail({ code: "RATE_LIMIT_EXHAUSTED", message: `Rate limit: gave up after ${maxRetries} retries` } as ProviderError);
  });

// ── Concurrency limiter (slot-based) ──────────────────────────────────────

const makeConcurrencyLimiter = (maxConcurrent: number) => {
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquirePromise = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (active < maxConcurrent) {
        active++;
        resolve();
      } else {
        waiters.push(() => { active++; resolve(); });
      }
    });

  const acquire = Effect.tryPromise({ try: acquirePromise, catch: () => ({ code: "SEMAPHORE_ERROR", message: "acquire failed" }) as ProviderError });
  const release = Effect.sync(() => { active--; waiters.shift()?.(); });

  return { acquire, release };
};

// ── Pacing config ──────────────────────────────────────────────────────────

export interface PacingConfig {
  /**
   * Max concurrent LLM calls. Excess calls are queued, not dropped.
   * Default: 3 — safe for Anthropic's default tier.
   */
  readonly maxConcurrent?: number;
  /**
   * Min delay between consecutive calls to the same provider (ms).
   * Useful for strict rpm limits. Default: 0 (no forced delay).
   */
  readonly minIntervalMs?: number;
  /**
   * Max retries on 429. Default: 5 (gives up to ~62s of backoff).
   */
  readonly maxRetries?: number;
}

// ── withPacing ─────────────────────────────────────────────────────────────

/**
 * Wraps a provider with:
 * 1. Concurrency cap — max N simultaneous LLM calls (queue, not drop)
 * 2. Minimum interval between calls — proactive throttling
 * 3. Exponential backoff retry on 429
 *
 * @example
 * const provider = withPacing(makeAnthropicProvider({ apiKey }), {
 *   maxConcurrent: 3,
 *   minIntervalMs: 500,
 *   maxRetries: 5,
 * });
 */
export const withPacing = (provider: Provider, config: PacingConfig = {}): Provider => {
  const { maxConcurrent = 3, minIntervalMs = 0, maxRetries = 5 } = config;
  const limiter = makeConcurrencyLimiter(maxConcurrent);
  let lastCallAt = 0;

  return {
    ...provider,
    chat: (messages, tools) =>
      Effect.gen(function* () {
        // 1. Wait for a concurrency slot
        yield* limiter.acquire;

        try {
          // 2. Enforce minimum interval (proactive pacing)
          if (minIntervalMs > 0) {
            const elapsed = Date.now() - lastCallAt;
            if (elapsed < minIntervalMs) {
              yield* Effect.sleep(Duration.millis(minIntervalMs - elapsed));
            }
          }
          lastCallAt = Date.now();

          // 3. Call with retry on 429
          return yield* retryOn429(provider.chat(messages, tools), maxRetries) as Effect.Effect<import("./types.js").ChatResponse, ProviderError>;
        } finally {
          yield* limiter.release;
        }
      }),
  };
};
