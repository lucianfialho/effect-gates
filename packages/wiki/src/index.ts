import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";

export interface WikiEntry {
  readonly path: string;
  readonly title: string;
  readonly content: string;
  readonly tags: string[];
  readonly created: number;
  readonly modified: number;
}

export interface WikiIndex {
  readonly entries: WikiEntry[];
  readonly totalEntries: number;
  readonly lastUpdated: number;
}

export class WikiError {
  readonly _tag = "WikiError";
  constructor(
    readonly code: string,
    readonly message: string
  ) {}
}

const WIKI_DIR = ".gates/wiki";
const INDEX_FILE = ".gates/wiki/index.json";

const parseFrontmatter = (content: string): { metadata: Record<string, string>; body: string } => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const [, frontmatter, body] = match;
  const metadata: Record<string, string> = {};

  for (const line of frontmatter.split("\n")) {
    const [key, ...valueParts] = line.split(":");
    if (key && valueParts.length > 0) {
      metadata[key.trim()] = valueParts.join(":").trim();
    }
  }

  return { metadata, body };
};

const serializeFrontmatter = (metadata: Record<string, string>, body: string): string => {
  const frontmatter = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  return `---\n${frontmatter}\n---\n${body}`;
};

export const loadWikiIndex = (
  rootPath: string = "."
): Effect.Effect<WikiIndex, WikiError> =>
  Effect.try({
    try: () => {
      const wikiPath = path.join(rootPath, INDEX_FILE);

      if (!fs.existsSync(wikiPath)) {
        return {
          entries: [],
          totalEntries: 0,
          lastUpdated: Date.now(),
        };
      }

      const content = fs.readFileSync(wikiPath, "utf-8");
      const index = JSON.parse(content) as WikiIndex;

      return index;
    },
    catch: (error: unknown) => new WikiError("INDEX_LOAD_ERROR", String(error)),
  });

export const saveWikiIndex = (
  index: WikiIndex,
  rootPath: string = "."
): Effect.Effect<void, WikiError> =>
  Effect.try({
    try: () => {
      const wikiDir = path.join(rootPath, WIKI_DIR);
      if (!fs.existsSync(wikiDir)) {
        fs.mkdirSync(wikiDir, { recursive: true });
      }

      const wikiPath = path.join(rootPath, INDEX_FILE);
      fs.writeFileSync(wikiPath, JSON.stringify(index, null, 2));
    },
    catch: (error: unknown) => new WikiError("INDEX_SAVE_ERROR", String(error)),
  });

export const getEntry = (
  entryPath: string,
  rootPath: string = "."
): Effect.Effect<WikiEntry, WikiError> =>
  Effect.try({
    try: () => {
      const fullPath = path.join(rootPath, WIKI_DIR, entryPath);

      if (!fs.existsSync(fullPath)) {
        throw new Error(`Wiki entry not found: ${entryPath}`);
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      const { metadata, body } = parseFrontmatter(content);
      const stats = fs.statSync(fullPath);

      return {
        path: entryPath,
        title: metadata.title ?? path.basename(entryPath, path.extname(entryPath)),
        content: body.trim(),
        tags: metadata.tags ? metadata.tags.split(",").map((t: string) => t.trim()) : [],
        created: stats.birthtime.getTime(),
        modified: stats.mtime.getTime(),
      };
    },
    catch: (error: unknown) => new WikiError("ENTRY_LOAD_ERROR", String(error)),
  });

export const saveEntry = (
  entry: WikiEntry,
  rootPath: string = "."
): Effect.Effect<void, WikiError> =>
  Effect.try({
    try: () => {
      const wikiDir = path.join(rootPath, WIKI_DIR);
      if (!fs.existsSync(wikiDir)) {
        fs.mkdirSync(wikiDir, { recursive: true });
      }

      const fullPath = path.join(wikiDir, entry.path);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const metadata: Record<string, string> = {
        title: entry.title,
        tags: entry.tags.join(", "),
      };

      const content = serializeFrontmatter(metadata, entry.content);
      fs.writeFileSync(fullPath, content, "utf-8");
    },
    catch: (error: unknown) => new WikiError("ENTRY_SAVE_ERROR", String(error)),
  });

export const searchWiki = (
  query: string,
  rootPath: string = "."
): Effect.Effect<WikiEntry[], WikiError> =>
  Effect.gen(function* () {
    const index = yield* loadWikiIndex(rootPath);
    const lowerQuery = query.toLowerCase();

    return index.entries.filter((entry) => {
      const titleMatch = entry.title.toLowerCase().includes(lowerQuery);
      const contentMatch = entry.content.toLowerCase().includes(lowerQuery);
      const tagsMatch = entry.tags.some((tag) => tag.toLowerCase().includes(lowerQuery));

      return titleMatch || contentMatch || tagsMatch;
    });
  });
