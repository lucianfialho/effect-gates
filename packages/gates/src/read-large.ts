import { Effect } from "effect";
import * as fs from "fs";

export interface ReadLargeOptions {
  readonly chunkSize?: number;
  readonly encoding?: BufferEncoding;
}

export class ReadLargeError {
  readonly _tag = "ReadLargeError";
  constructor(
    readonly code: string,
    readonly message: string
  ) {}
}

const DEFAULT_CHUNK_SIZE = 64 * 1024;

export const readLarge = (
  filePath: string,
  options: ReadLargeOptions = {}
): Effect.Effect<string, ReadLargeError> =>
  Effect.try_({
    try: () => {
      const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
      const encoding = options.encoding ?? "utf-8";
      const fd = fs.openSync(filePath, "r");
      const chunks: string[] = [];

      try {
        const buffer = Buffer.alloc(chunkSize);
        let position = 0;
        let bytesRead: number;

        while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
          chunks.push(buffer.slice(0, bytesRead).toString(encoding));
          position += bytesRead;
        }
      } finally {
        fs.closeSync(fd);
      }

      return chunks.join("");
    },
    catch: (e) => new ReadLargeError("READ_ERROR", String(e)),
  });
