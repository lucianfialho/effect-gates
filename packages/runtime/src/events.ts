import { Effect, PubSub, Stream } from "effect";

export type AgentEventType =
  | "agent_start"
  | "agent_end"
  | "text_delta"
  | "tool_start"
  | "tool_end"
  | "tool_error"
  | "compaction_start"
  | "compaction_end"
  | "message_sent"
  | "message_received"
  | "error";

export interface AgentEvent {
  readonly type: AgentEventType;
  readonly timestamp: number;
  readonly data?: unknown;
}

export interface AgentEvents {
  readonly publish: (event: AgentEvent) => Effect.Effect<void>;
  readonly subscribe: (handler: (event: AgentEvent) => void) => Effect.Effect<void>;
  readonly getStream: () => Stream.Stream<AgentEvent, never>;
}

export const makeAgentEvents = (): Effect.Effect<AgentEvents> =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.bounded<AgentEvent>(100);
    const stream = Stream.fromPubSub(pubsub);

    const publish = (event: AgentEvent): Effect.Effect<void> =>
      Effect.asVoid(PubSub.publish(pubsub, event));

    const subscribe = (handler: (event: AgentEvent) => void): Effect.Effect<void> =>
      Stream.runForEach(stream, (event) =>
        Effect.sync(() => handler(event))
      );

    return {
      publish,
      subscribe,
      getStream: () => Stream.fromPubSub(pubsub),
    };
  });

export const createEventFilter = (types: AgentEventType[]) =>
  (stream: Stream.Stream<AgentEvent, never>): Stream.Stream<AgentEvent, never> =>
    stream.pipe(Stream.filter((event) => types.includes(event.type)));

export const mergeEvents = (
  streams: Array<Stream.Stream<AgentEvent, never>>
): Stream.Stream<AgentEvent, never> =>
  streams.reduce((acc, stream) => Stream.merge(acc, stream), Stream.empty);

export const streamTextDelta = (
  events: AgentEvents,
  text: string,
  chunkSize = 10
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const chars = text.split("");
    for (let i = 0; i < chars.length; i += chunkSize) {
      const chunk = chars.slice(i, i + chunkSize).join("");
      yield* events.publish({ type: "text_delta", timestamp: Date.now(), data: { text: chunk } });
    }
  });