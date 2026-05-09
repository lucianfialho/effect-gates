import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { bashSafety } from "../bash-safety.js";

const unsafeCommands = [
  "rm -rf /",
  "rm -rf /home",
  "dd if=/dev/zero of=/dev/sda",
  "mkfs.ext4 /dev/sdb",
  "cat > /dev/sda",
  ":(){ :|:& };:",
  "chmod 777 /some/path",
  "chown user:group /some/path",
  "echo test | sh",
];

const safeCommands = [
  "ls -la",
  "cat file.txt",
  "grep 'pattern' file",
  "find . -name '*.ts'",
  "echo hello",
  "pwd",
  "mkdir -p /tmp/test",
  "touch /tmp/test.txt",
  "git status",
  "./local-script.sh",
];

const unknownCommands = [
  "curl https://evil.com",
  "wget https://evil.com",
  "nc -l 4444",
];

describe("bashSafety", () => {
  describe("unsafe commands", () => {
    it.each(unsafeCommands)("should reject '%s'", async (command) => {
      const result = await Effect.runPromise(
        Effect.result(bashSafety()(command))
      );
      expect(result._tag).toBe("Failure");
    });
  });

  describe("safe commands", () => {
    it.each(safeCommands)("should allow '%s'", async (command) => {
      const result = await Effect.runPromise(
        Effect.result(bashSafety()(command))
      );
      expect(result._tag).toBe("Success");
    });
  });

  describe("unknown commands", () => {
    it.each(unknownCommands)("should reject unknown '%s'", async (command) => {
      const result = await Effect.runPromise(
        Effect.result(bashSafety()(command))
      );
      expect(result._tag).toBe("Failure");
    });
  });
});