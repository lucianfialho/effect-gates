import { Effect, Stream } from "effect";
import type { AgentEvent } from "./events.js";

export interface SSEMessage {
  readonly event: string;
  readonly data: string;
}

export const eventToSSE = (event: AgentEvent): SSEMessage => ({
  event: event.type,
  data: JSON.stringify(event),
});

export const formatSSE = (message: SSEMessage): string =>
  `event: ${message.event}\ndata: ${message.data}\n\n`;

export const eventToSSELines = (event: AgentEvent): string =>
  formatSSE(eventToSSE(event));

export const streamToSSE = (
  stream: Stream.Stream<AgentEvent, never>
): Stream.Stream<string, never> =>
  stream.pipe(Stream.map(eventToSSELines));

export const eventsToSSEStream = (
  events: { getStream: () => Stream.Stream<AgentEvent, never> }
): Stream.Stream<string, never> =>
  streamToSSE(events.getStream());

export const parseSSELine = (line: string): { key: string; value: string } | null => {
  if (!line || line.startsWith(":")) return null;
  const [key, ...rest] = line.split(":");
  if (!key) return null;
  return { key: key.trim(), value: rest.join(":").trim() };
};

export const parseSSEData = (lines: string[]): { event?: string; data?: string } => {
  let event: string | undefined;
  let data: string | undefined;

  for (const line of lines) {
    const parsed = parseSSELine(line);
    if (!parsed) continue;

    if (parsed.key === "event") {
      event = parsed.value;
    } else if (parsed.key === "data") {
      data = parsed.value;
    }
  }

  return { event, data };
};

export const combineEvents = (
  streams: Array<Stream.Stream<AgentEvent, never>>
): Stream.Stream<AgentEvent, never> =>
  streams.reduce((acc, stream) => acc.pipe(Stream.merge(stream)), Stream.empty);

export const filterEventsByType = (
  stream: Stream.Stream<AgentEvent, never>,
  types: string[]
): Stream.Stream<AgentEvent, never> =>
  stream.pipe(Stream.filter((event: AgentEvent) => types.includes(event.type)));

export const mapEventData = <T>(
  stream: Stream.Stream<AgentEvent, never>,
  mapper: (event: AgentEvent) => T
): Stream.Stream<T, never> =>
  stream.pipe(Stream.map(mapper));

export interface SSEHandler {
  onEvent: (event: AgentEvent) => void;
  onError?: (error: unknown) => void;
  onEnd?: () => void;
}

export const createSSEHandler = (handler: SSEHandler) => ({
  handle: (eventData: string, eventType?: string) => {
    try {
      const parsed = JSON.parse(eventData);
      const event: AgentEvent = {
        type: (eventType ?? parsed.type ?? "message") as AgentEvent["type"],
        timestamp: parsed.timestamp ?? Date.now(),
        data: parsed.data,
      };
      handler.onEvent(event);
    } catch (e) {
      handler.onError?.(e);
    }
  },
  end: () => handler.onEnd?.(),
});

export const writeSSELines = (
  event: AgentEvent
): ReadonlyArray<string> => {
  const lines: string[] = [];
  lines.push(`event: ${event.type}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  lines.push("");
  return lines;
};

export const createSSEPublisher = (
  events: { publish: (event: AgentEvent) => Effect.Effect<void> }
) => {
  const publishSSE = (event: AgentEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      const lines = writeSSELines(event);
      for (const line of lines) {
        process.stdout.write(line + "\n");
      }
    });

  return {
    publishSSE,
    publishEvent: events.publish,
  };
};

export const createSSEStream = (
  events: { getStream: () => Stream.Stream<AgentEvent, never> }
): Stream.Stream<string, never> =>
  events.getStream().pipe(Stream.map(eventToSSELines));

