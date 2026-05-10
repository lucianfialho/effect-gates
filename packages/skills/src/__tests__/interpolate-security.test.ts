import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { injectFiles } from "../interpolate.js";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";

describe("injectFiles — path traversal guard", () => {
  it("injects a file within basePath", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gates-test-"));
    await fs.writeFile(path.join(dir, "hello.txt"), "hello world");

    const result = await Effect.runPromise(
      injectFiles("content: {{file:hello.txt}}", dir)
    );
    expect(result).toBe("content: hello world");
    await fs.rm(dir, { recursive: true });
  });

  it("blocks path traversal with ../../", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gates-test-"));

    const result = await Effect.runPromise(
      injectFiles("{{file:../../etc/passwd}}", dir)
    );
    expect(result).toContain("[file access denied:");
    await fs.rm(dir, { recursive: true });
  });

  it("blocks absolute paths outside basePath", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gates-test-"));

    const result = await Effect.runPromise(
      injectFiles("{{file:/etc/passwd}}", dir)
    );
    expect(result).toContain("[file access denied:");
    await fs.rm(dir, { recursive: true });
  });

  it("returns [file not found] for missing file within basePath", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gates-test-"));

    const result = await Effect.runPromise(
      injectFiles("{{file:nonexistent.txt}}", dir)
    );
    expect(result).toContain("[file not found:");
    await fs.rm(dir, { recursive: true });
  });
});
