import { Effect } from "effect";
import type { AgentEventType, AgentEvent } from "./events.js";

export type { AgentEventType, AgentEvent };

export interface AgentEventHandlers {
  onEvent?: (event: AgentEvent) => void;
  onError?: (error: unknown, event: AgentEvent) => void;
}

export interface TelemetryPlugin {
  readonly name: string;
  readonly handlers: AgentEventHandlers;
  readonly flush?: () => Effect.Effect<void>;
}

export const createTelemetryPlugin = (
  name: string,
  handlers: AgentEventHandlers
): TelemetryPlugin => ({
  name,
  handlers,
});

export const composeTelemetryPlugins = (
  plugins: TelemetryPlugin[]
): AgentEventHandlers => ({
  onEvent: (event) => plugins.forEach((p) => p.handlers.onEvent?.(event)),
  onError: (error, event) => plugins.forEach((p) => p.handlers.onError?.(error, event)),
});

export const withTelemetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  plugins: TelemetryPlugin[]
): Effect.Effect<A, E, R> => {
  const handlers = composeTelemetryPlugins(plugins);
  const emit = (event: AgentEvent) => {
    try { handlers.onEvent?.(event); } catch (err) { handlers.onError?.(err, event); }
  };

  return Effect.gen(function* () {
    emit({ type: "agent_start", timestamp: Date.now() });
    return yield* effect;
  }).pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (exit._tag === "Failure") {
          emit({ type: "error", timestamp: Date.now(), data: { cause: String(exit.cause) } });
        }
        emit({ type: "agent_end", timestamp: Date.now() });
      })
    )
  );
};

export const withToolTelemetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  plugins: TelemetryPlugin[],
  toolName: string
): Effect.Effect<A, E, R> => {
  const handlers = composeTelemetryPlugins(plugins);
  const emit = (event: AgentEvent) => {
    try { handlers.onEvent?.(event); } catch (err) { handlers.onError?.(err, event); }
  };

  return Effect.gen(function* () {
    emit({ type: "tool_start", timestamp: Date.now(), data: { toolName } });
    return yield* effect;
  }).pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (exit._tag === "Failure") {
          emit({ type: "tool_error", timestamp: Date.now(), data: { toolName, cause: String(exit.cause) } });
        }
        emit({ type: "tool_end", timestamp: Date.now(), data: { toolName, success: exit._tag === "Success" } });
      })
    )
  );
};

export const createSpan = (name: string, data?: Record<string, unknown>) => {
  const start = Date.now();
  return {
    name,
    start,
    end: () => ({
      name,
      durationMs: Date.now() - start,
      data,
    }),
  };
};

export const withSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  name: string,
  plugins: TelemetryPlugin[]
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const span = createSpan(name);
    const handlers = composeTelemetryPlugins(plugins);

    handlers.onEvent?.({ type: "agent_start", timestamp: span.start, data: { name } });

    const result = yield* effect;
    const ended = span.end();

    handlers.onEvent?.({
      type: "agent_end",
      timestamp: Date.now(),
      data: { name: ended.name, durationMs: ended.durationMs },
    });

    return result;
  });