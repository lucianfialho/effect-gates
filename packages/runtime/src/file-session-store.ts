import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { SessionStore, SessionData } from "./session-history.js";

const SESSION_DIR = path.join(os.homedir(), ".gates", "sessions");

const ensureDir = (): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
  });

const sessionPath = (key: string): string => {
  const safeName = key.replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(SESSION_DIR, `${safeName}.json`);
};

export const makeFileSessionStore = (): Effect.Effect<SessionStore> =>
  Effect.gen(function* () {
    yield* ensureDir();

    return {
      save: (key: string, data: SessionData) =>
        Effect.sync(() => {
          const filePath = sessionPath(key);
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }),

      load: (key: string) =>
        Effect.sync(() => {
          const filePath = sessionPath(key);
          if (!fs.existsSync(filePath)) return null;
          try {
            return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SessionData;
          } catch {
            return null;
          }
        }),

      delete: (key: string) =>
        Effect.sync(() => {
          const filePath = sessionPath(key);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }),
    } satisfies SessionStore;
  });

export const listSessions = (): Effect.Effect<string[]> =>
  Effect.sync(() => {
    if (!fs.existsSync(SESSION_DIR)) return [];
    return fs
      .readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""));
  });