import { Effect, Ref } from "effect";

export type MessageRole = "user" | "assistant" | "system" | "context" | "tool";

export interface Message {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly timestamp: number;
}

export interface SessionEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
}

export interface MessageEntry extends SessionEntry {
  readonly type: "message";
  readonly message: Message;
  readonly source?: "user" | "prompt" | "skill" | "shell";
}

export interface CompactionEntry extends SessionEntry {
  readonly type: "compaction";
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly details?: {
    readonly readFiles: readonly string[];
    readonly modifiedFiles: readonly string[];
  };
}

export interface BranchSummaryEntry extends SessionEntry {
  readonly type: "branch_summary";
  readonly fromId: string;
  readonly summary: string;
  readonly details?: unknown;
}

export type SessionEntryType = MessageEntry | CompactionEntry | BranchSummaryEntry;

export interface SessionData {
  readonly version: number;
  readonly entries: readonly SessionEntryType[];
  readonly leafId: string | null;
  readonly metadata: Record<string, string>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionStore {
  save(key: string, data: SessionData): Effect.Effect<void>;
  load(key: string): Effect.Effect<SessionData | null>;
  delete(key: string): Effect.Effect<void>;
}

export const makeInMemorySessionStore = (): Effect.Effect<SessionStore> =>
  Effect.gen(this, function* () {
    const store = yield* Ref.make<Map<string, SessionData>>(new Map());

    return {
      save: (key: string, data: SessionData) =>
        Effect.gen(this, function* () {
          const map = yield* Ref.get(store);
          yield* Ref.set(store, new Map(map).set(key, data));
        }),

      load: (key: string) =>
        Effect.map(Ref.get(store), (map) => map.get(key) ?? null),

      delete: (key: string) =>
        Effect.gen(this, function* () {
          const map = yield* Ref.get(store);
          const newMap = new Map(map);
          newMap.delete(key);
          yield* Ref.set(store, newMap);
        }),
    };
  });

interface HistoryState {
  entries: readonly SessionEntryType[];
  leafId: string | null;
  byId: Map<string, SessionEntryType>;
  createdAt: string;
}

export class SessionHistory {
  private constructor(private readonly state: Ref.Ref<HistoryState>) {}

  static empty(): Effect.Effect<SessionHistory> {
    return Effect.map(
      Ref.make<HistoryState>({ entries: [], leafId: null, byId: new Map(), createdAt: new Date().toISOString() }),
      (state) => new SessionHistory(state)
    );
  }

  static fromData(data: SessionData | null): Effect.Effect<SessionHistory> {
    if (!data) return this.empty();
    return Effect.map(
      Ref.make<HistoryState>({
        entries: data.entries,
        leafId: data.leafId,
        byId: new Map(data.entries.map((e) => [e.id, e])),
        createdAt: data.createdAt,
      }),
      (state) => new SessionHistory(state)
    );
  }

  getActivePath(): Effect.Effect<SessionEntryType[]> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.state);
      if (!state.leafId) return [];

      const path: SessionEntryType[] = [];
      let current = state.byId.get(state.leafId);

      while (current) {
        path.push(current);
        current = current.parentId ? state.byId.get(current.parentId) : undefined;
      }

      return path.reverse();
    });
  }

  buildContext(): Effect.Effect<Message[]> {
    return Effect.gen(this, function* () {
      const path = yield* this.getActivePath();
      const latestCompactionIndex = findLatestCompactionIndex(path);

      if (latestCompactionIndex === -1) {
        return path
          .filter((entry): entry is MessageEntry => entry.type === "message")
          .map((entry) => entry.message);
      }

      const compaction = path[latestCompactionIndex] as CompactionEntry;
      const contextSummary = createContextSummaryMessage(compaction.summary, compaction.timestamp);

      const keptEntries = path.slice(latestCompactionIndex + 1);
      const messages = keptEntries
        .filter((entry): entry is MessageEntry => entry.type === "message")
        .map((entry) => entry.message);

      return [contextSummary, ...messages];
    });
  }

  getTotalTokens(): Effect.Effect<number> {
    return Effect.map(Ref.get(this.state), (s) => {
      let total = 0;
      for (const entry of s.entries) {
        if (entry.type === "message") {
          total += Math.ceil(entry.message.content.length / 4);
        } else if (entry.type === "compaction") {
          total += Math.ceil(entry.summary.length / 4);
        } else if (entry.type === "branch_summary") {
          total += Math.ceil(String(entry.summary).length / 4);
        }
      }
      return total;
    });
  }

  appendMessage(message: Message, source?: "user" | "prompt" | "skill" | "shell"): Effect.Effect<string> {
    return Effect.gen(this, function* () {
      const current = yield* Ref.get(this.state);
      const id = generateEntryId(current.byId);

      const entry: MessageEntry = {
        type: "message",
        id,
        parentId: current.leafId,
        timestamp: new Date().toISOString(),
        message,
        source,
      };

      const newById = new Map(current.byId);
      newById.set(id, entry);

      yield* Ref.set(this.state, {
        entries: [...current.entries, entry],
        leafId: id,
        byId: newById,
      });

      return id;
    });
  }

appendCompaction(input: {
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly details?: {
    readonly readFiles: readonly string[];
    readonly modifiedFiles: readonly string[];
  };
 }): Effect.Effect<string, Error> {
    return Effect.gen(this, function* () {
      const current = yield* Ref.get(this.state);

      if (!current.byId.has(input.firstKeptEntryId)) {
        return yield* Effect.fail(
          new Error(`Cannot compact: entry "${input.firstKeptEntryId}" does not exist`)
        );
      }

      const id = generateEntryId(current.byId);
      const entry: CompactionEntry = {
        type: "compaction",
        id,
        parentId: current.leafId,
        timestamp: new Date().toISOString(),
        summary: input.summary,
        firstKeptEntryId: input.firstKeptEntryId,
        tokensBefore: input.tokensBefore,
        details: input.details,
      };

      const newById = new Map(current.byId);
      newById.set(id, entry);

      yield* Ref.set(this.state, {
        entries: [...current.entries, entry],
        leafId: id,
        byId: newById,
      });

      return id;
    });
  }

  appendBranchSummary(fromId: string, summary: string, details?: unknown): Effect.Effect<string> {
    return Effect.gen(this, function* () {
      const current = yield* Ref.get(this.state);
      const id = generateEntryId(current.byId);

      const entry: BranchSummaryEntry = {
        type: "branch_summary",
        id,
        parentId: current.leafId,
        timestamp: new Date().toISOString(),
        fromId,
        summary,
        details,
      };

      const newById = new Map(current.byId);
      newById.set(id, entry);

      yield* Ref.set(this.state, {
        entries: [...current.entries, entry],
        leafId: id,
        byId: newById,
      });

      return id;
    });
  }

  toData(metadata: Record<string, string>): Effect.Effect<SessionData> {
    return Effect.map(Ref.get(this.state), (s) => ({
      version: 2,
      entries: s.entries,
      leafId: s.leafId,
      metadata,
      createdAt: s.createdAt,
      updatedAt: new Date().toISOString(),
    }));
  }
}

function findLatestCompactionIndex(path: SessionEntryType[]): number {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.type === "compaction") return i;
  }
  return -1;
}

function createContextSummaryMessage(summary: string, timestamp: string): Message {
  const text = summary.startsWith("[Context Summary]")
    ? summary
    : `[Context Summary]\n\n${summary}`;

  return {
    id: crypto.randomUUID(),
    role: "context",
    content: text,
    timestamp: new Date(timestamp).getTime(),
  };
}

function generateEntryId(_byId: Map<string, SessionEntryType>): string {
  return crypto.randomUUID();
}