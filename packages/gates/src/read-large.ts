import { Effect } from "effect";
import * as fs from "fs";

export interface ReadLargeOptions {
  readonly chunkSize?: number;
  readonly encoding?: BufferEncoding;
  readonly maxOutputSize?: number;
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
  Effect.try({
    try: () => {
      const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
      const encoding = options.encoding ?? "utf-8";
      const maxOutputSize = options.maxOutputSize;

      // Guard: check file size before reading to avoid loading huge files into memory
      const stat = fs.statSync(filePath);
      if (maxOutputSize !== undefined && stat.size > maxOutputSize) {
        throw Object.assign(
          new Error(
            `File "${filePath}" is ${stat.size} bytes which exceeds maxOutputSize of ${maxOutputSize} bytes`
          ),
          { code: "FILE_TOO_LARGE" }
        );
      }

      const fd = fs.openSync(filePath, "r");
      const chunks: string[] = [];

      try {
        const buffer = Buffer.alloc(chunkSize);
        let position = 0;
        let bytesRead: number;
        let totalRead = 0;

        while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
          // Enforce maxOutputSize during streaming as a second line of defence
          if (maxOutputSize !== undefined && totalRead + bytesRead > maxOutputSize) {
            const allowed = maxOutputSize - totalRead;
            if (allowed > 0) chunks.push(buffer.slice(0, allowed).toString(encoding));
            break;
          }
          chunks.push(buffer.slice(0, bytesRead).toString(encoding));
          position += bytesRead;
          totalRead += bytesRead;
        }
      } finally {
        fs.closeSync(fd);
      }

      return chunks.join("");
    },
    catch: (e) => new ReadLargeError("READ_ERROR", String(e)),
  });
