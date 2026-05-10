import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { makeTaskQueue } from "../tasks.js";

describe("TaskQueue", () => {
  it("adds a task and returns an id", async () => {
    const queue = await Effect.runPromise(makeTaskQueue());
    const id = await Effect.runPromise(queue.add({ name: "t1", skill: "s", input: {} }));
    expect(typeof id).toBe("string");
  });

  it("marks a task ready when it has no dependencies", async () => {
    const queue = await Effect.runPromise(makeTaskQueue());
    await Effect.runPromise(queue.add({ name: "t1", skill: "s", input: {} }));
    const ready = await Effect.runPromise(queue.ready());
    expect(ready).toHaveLength(1);
  });

  it("blocks a task until its dependency completes", async () => {
    const queue = await Effect.runPromise(makeTaskQueue());
    const dep = await Effect.runPromise(queue.add({ name: "dep", skill: "s", input: {} }));
    await Effect.runPromise(queue.add({ name: "child", skill: "s", input: {}, dependencies: [dep] }));

    const ready1 = await Effect.runPromise(queue.ready());
    expect(ready1.map((t) => t.name)).toEqual(["dep"]);

    // Complete dep
    const claimed = await Effect.runPromise(queue.claim(dep));
    await Effect.runPromise(queue.complete(claimed.id, { skillName: "s", input: {}, state: "done", results: [], errors: [], metadata: {} }));

    const ready2 = await Effect.runPromise(queue.ready());
    expect(ready2.map((t) => t.name)).toEqual(["child"]);
  });

  it("detects a direct dependency cycle", async () => {
    const queue = await Effect.runPromise(makeTaskQueue());
    const a = await Effect.runPromise(queue.add({ name: "a", skill: "s", input: {} }));
    // b depends on a (fine), but listing a twice is a cycle signal
    const result = await Effect.runPromise(
      Effect.result(queue.add({ name: "b", skill: "s", input: {}, dependencies: [a, a] }))
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("DEPENDENCY_CYCLE");
    }
  });

  it("stats reflect task statuses correctly", async () => {
    const queue = await Effect.runPromise(makeTaskQueue());
    const id = await Effect.runPromise(queue.add({ name: "t", skill: "s", input: {} }));
    await Effect.runPromise(queue.claim(id));

    const stats = await Effect.runPromise(queue.stats());
    expect(stats.in_progress).toBe(1);
    expect(stats.pending).toBe(0);
  });
});
