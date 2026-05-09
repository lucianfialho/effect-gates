import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CodeChunk {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly type: "function" | "class" | "method" | "block" | "file";
  readonly name?: string;
}

export interface IndexedChunk extends CodeChunk {
  readonly embedding: number[];
}

export interface SearchResult {
  readonly chunk: CodeChunk;
  readonly score: number;
}

export interface SemanticIndex {
  readonly chunks: IndexedChunk[];
  readonly indexedAt: number;
  readonly rootPath: string;
}

export class SemanticSearchError {
  readonly _tag = "SemanticSearchError";
  constructor(readonly code: string, readonly message: string) {}
}

// ── Text chunking (no tree-sitter dependency) ─────────────────────────────────

/**
 * Splits a file into chunks by function/class boundaries using regex heuristics.
 * Works on TypeScript, JavaScript, and similar languages.
 * For AST-accurate chunking, install tree-sitter (optional).
 */
const chunkByBoundaries = (content: string, filePath: string): CodeChunk[] => {
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];
  const CHUNK_SIZE = 50; // lines per chunk
  const OVERLAP = 5;

  // Try to find function/class boundaries
  const boundaryRe = /^(?:export\s+)?(?:async\s+)?(?:function|class|const\s+\w+\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))/;

  let chunkStart = 0;
  const boundaries: number[] = [0];

  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && boundaryRe.test(lines[i]!.trim())) {
      boundaries.push(i);
    }
  }
  boundaries.push(lines.length);

  // Create chunks from boundaries, merging small ones
  for (let b = 0; b < boundaries.length - 1; b++) {
    const start = boundaries[b]!;
    const end = Math.min(boundaries[b + 1]!, start + CHUNK_SIZE * 2);

    if (end - start < 3) continue; // skip tiny chunks

    // Extract name hint from first line
    const firstLine = lines[start]?.trim() ?? "";
    const nameMatch = firstLine.match(/(?:function|class|const)\s+(\w+)/);

    chunks.push({
      filePath,
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join("\n"),
      type: firstLine.includes("class") ? "class" : "function",
      name: nameMatch?.[1],
    });

    if (end >= lines.length) break;
  }

  // If no boundaries found, chunk by fixed size
  if (chunks.length === 0) {
    for (let i = 0; i < lines.length; i += CHUNK_SIZE - OVERLAP) {
      const end = Math.min(i + CHUNK_SIZE, lines.length);
      chunks.push({
        filePath,
        startLine: i + 1,
        endLine: end,
        content: lines.slice(i, end).join("\n"),
        type: "block",
      });
    }
  }

  return chunks;
};

// ── File discovery ────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".py", ".go", ".rs", ".md"];

const discoverFiles = (rootPath: string, extensions = SUPPORTED_EXTENSIONS): string[] => {
  const results: string[] = [];
  const IGNORE = ["node_modules", "dist", ".git", "coverage", ".cache"];

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) results.push(full);
    }
  };

  walk(rootPath);
  return results;
};

// ── Embeddings via OpenAI ─────────────────────────────────────────────────────

const generateEmbeddings = async (
  texts: string[],
  apiKey: string,
  model = "text-embedding-3-small"
): Promise<number[][]> => {
  const BATCH_SIZE = 100;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ input: batch, model }),
    });

    if (!response.ok) throw new Error(`OpenAI embeddings error: ${response.status}`);
    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    results.push(...data.data.map((d) => d.embedding));
  }

  return results;
};

// ── Cosine similarity ─────────────────────────────────────────────────────────

const cosineSimilarity = (a: number[], b: number[]): number => {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! ** 2;
    normB += b[i]! ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a semantic index for a codebase.
 *
 * @example
 * const index = yield* buildIndex("./src", process.env.OPENAI_API_KEY!);
 * const results = yield* searchIndex(index, "authentication token validation");
 */
export const buildIndex = (
  rootPath: string,
  openAiApiKey: string,
  options?: { extensions?: string[]; embeddingModel?: string }
): Effect.Effect<SemanticIndex, SemanticSearchError> =>
  Effect.gen(function* () {
    const files = discoverFiles(rootPath, options?.extensions);

    const allChunks: CodeChunk[] = [];
    for (const file of files) {
      const content = yield* Effect.result(
        Effect.try({ try: () => fs.readFileSync(file, "utf-8"), catch: (e) => new Error(String(e)) })
      );
      if (content._tag === "Success") {
        allChunks.push(...chunkByBoundaries(content.success, file));
      }
    }

    if (allChunks.length === 0) {
      return yield* Effect.fail(new SemanticSearchError("NO_CHUNKS", `No indexable files found in ${rootPath}`));
    }

    const texts = allChunks.map((c) => `${c.name ? `${c.name}\n` : ""}${c.content}`);
    const embeddingsResult = yield* Effect.result(
      Effect.tryPromise({
        try: () => generateEmbeddings(texts, openAiApiKey, options?.embeddingModel),
        catch: (e) => new SemanticSearchError("EMBEDDING_ERROR", String(e)),
      })
    );

    if (embeddingsResult._tag === "Failure") return yield* Effect.fail(embeddingsResult.failure);

    const indexed: IndexedChunk[] = allChunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddingsResult.success[i]!,
    }));

    return { chunks: indexed, indexedAt: Date.now(), rootPath };
  });

/**
 * Search the semantic index for code relevant to a query.
 */
export const searchIndex = (
  index: SemanticIndex,
  query: string,
  openAiApiKey: string,
  options?: { topK?: number; embeddingModel?: string }
): Effect.Effect<SearchResult[], SemanticSearchError> =>
  Effect.gen(function* () {
    const topK = options?.topK ?? 5;

    const embResult = yield* Effect.result(
      Effect.tryPromise({
        try: () => generateEmbeddings([query], openAiApiKey, options?.embeddingModel),
        catch: (e) => new SemanticSearchError("EMBEDDING_ERROR", String(e)),
      })
    );
    if (embResult._tag === "Failure") return yield* Effect.fail(embResult.failure);

    const queryEmbedding = embResult.success[0]!;

    return index.chunks
      .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  });

/**
 * Format search results as readable text for LLM context injection.
 */
export const formatResults = (results: SearchResult[]): string =>
  results
    .map((r, i) =>
      `### ${i + 1}. ${r.chunk.filePath}:${r.chunk.startLine}-${r.chunk.endLine}` +
      (r.chunk.name ? ` (${r.chunk.type}: ${r.chunk.name})` : "") +
      ` [score: ${r.score.toFixed(3)}]\n\`\`\`\n${r.chunk.content}\n\`\`\``
    )
    .join("\n\n");
