import { Effect, Ref } from "effect";
import * as fs from "fs";
import * as path from "path";
import type { SkillConfig, SkillExecutorConfig, SkillContext, SkillError } from "./types.js";
import { makeSkillExecutor } from "./executor.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Task {
  readonly id: string;
  readonly name: string;
  /** Name of the skill to execute */
  readonly skill: string;
  readonly input: Record<string, unknown>;
  /** IDs of tasks that must complete before this one can start */
  readonly dependencies: readonly string[];
  readonly status: TaskStatus;
  readonly result?: SkillContext;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TaskError {
  readonly code: "TASK_NOT_FOUND" | "TASK_NOT_PENDING" | "DEPENDENCY_CYCLE";
  readonly message: string;
}

export interface TaskStats {
  readonly pending: number;
  readonly in_progress: number;
  readonly completed: number;
  readonly failed: number;
  readonly total: number;
}

// ── Queue interface ─────────────────────────────────────────────────────────

export interface TaskQueue {
  /** Add a task and return its ID. Fails with DEPENDENCY_CYCLE if deps form a cycle. */
  add(task: {
    name: string;
    skill: string;
    input: Record<string, unknown>;
    dependencies?: string[];
  }): Effect.Effect<string, TaskError>;

  get(id: string): Effect.Effect<Task | null>;
  list(): Effect.Effect<readonly Task[]>;

  /** Pending tasks whose dependencies are all completed */
  ready(): Effect.Effect<readonly Task[]>;

  claim(id: string): Effect.Effect<Task, TaskError>;
  complete(id: string, result: SkillContext): Effect.Effect<void>;
  fail(id: string, error: string): Effect.Effect<void>;
  stats(): Effect.Effect<TaskStats>;
  reset(): Effect.Effect<void>;
}

export interface TaskRunnerOptions {
  readonly concurrency?: number | "unbounded";
  readonly onTaskStart?: (task: Task) => void;
  readonly onTaskComplete?: (task: Task) => void;
  readonly onTaskFail?: (task: Task, error: string) => void;
}

export interface TaskRunner {
  /**
   * Run all pending tasks respecting dependency order.
   * Runs waves of ready tasks in parallel until the queue is drained.
   * Returns the final state of all tasks.
   */
  runAll(options?: TaskRunnerOptions): Effect.Effect<readonly Task[], SkillError>;
}

// ── In-memory queue ─────────────────────────────────────────────────────────

export const makeTaskQueue = (): Effect.Effect<TaskQueue> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<Map<string, Task>>(new Map());

    const update = (id: string, patch: Partial<Task>): Effect.Effect<void> =>
      Ref.update(ref, (m) => {
        const t = m.get(id);
        if (!t) return m;
        return new Map(m).set(id, { ...t, ...patch, updatedAt: Date.now() });
      });

    return makeQueueFromRef(ref, update);
  });

// ── File-persisted queue ────────────────────────────────────────────────────

export const makeFileTaskQueue = (
  name: string,
  basePath: string = process.cwd()
): Effect.Effect<TaskQueue> =>
  Effect.gen(function* () {
    const dir = path.join(basePath, ".gates", "tasks");
    const filePath = path.join(dir, `${name}.json`);

    // Load or init — errors are absorbed, fallback to empty map
    const initial: Map<string, Task> = yield* Effect.gen(function* () {
      yield* Effect.result(Effect.tryPromise({
        try: () => fs.promises.mkdir(dir, { recursive: true }),
        catch: (e) => new Error(String(e)),
      }));
      const loaded = yield* Effect.result(Effect.tryPromise({
        try: async () => {
          const raw = await fs.promises.readFile(filePath, "utf-8");
          const arr = JSON.parse(raw) as Task[];
          return new Map(arr.map((t) => [t.id, t]));
        },
        catch: (e) => new Error(String(e)),
      }));
      return loaded._tag === "Success" ? loaded.success : new Map<string, Task>();
    });

    const ref = yield* Ref.make<Map<string, Task>>(initial);

    // persist absorbs write errors — in-memory state remains valid even on failure
    const persist = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const m = yield* Ref.get(ref);
        yield* Effect.result(Effect.tryPromise({
          try: () =>
            fs.promises.writeFile(filePath, JSON.stringify([...m.values()], null, 2)),
          catch: (e) => new Error(String(e)),
        }));
      });

    const update = (id: string, patch: Partial<Task>): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(ref, (m) => {
          const t = m.get(id);
          if (!t) return m;
          return new Map(m).set(id, { ...t, ...patch, updatedAt: Date.now() });
        });
        yield* persist();
      });

    const queue = makeQueueFromRef(ref, update);

    // Override add to also persist
    return {
      ...queue,
      add: (task) =>
        Effect.gen(function* () {
          const id = yield* queue.add(task);
          yield* persist();
          return id;
        }),
      reset: () => Effect.gen(function* () {
        yield* queue.reset();
        yield* persist();
      }),
    };
  });

// ── Shared queue logic ───────────────────────────────────────────────────────

const makeQueueFromRef = (
  ref: Ref.Ref<Map<string, Task>>,
  update: (id: string, patch: Partial<Task>) => Effect.Effect<void>
): TaskQueue => {
  const list = (): Effect.Effect<readonly Task[]> =>
    Effect.map(Ref.get(ref), (m) => [...m.values()]);

  const get = (id: string): Effect.Effect<Task | null> =>
    Effect.map(Ref.get(ref), (m) => m.get(id) ?? null);

  const add = (task: {
    name: string;
    skill: string;
    input: Record<string, unknown>;
    dependencies?: string[];
  }): Effect.Effect<string, TaskError> =>
    Effect.gen(function* () {
      const deps = task.dependencies ?? [];

      // Cycle detection: DFS from each declared dependency back to any node
      // that would transitively reach the new task (which has no id yet,
      // so we check that no existing dep chain already forms a cycle).
      if (deps.length > 0) {
        const existing = yield* Effect.map(Ref.get(ref), (m) => m);
        const visited = new Set<string>();
        const stack = [...deps];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          if (visited.has(cur)) continue;
          visited.add(cur);
          const node = existing.get(cur);
          if (node) stack.push(...node.dependencies);
        }
        // If any declared dep transitively depends on another declared dep
        // in a way that would loop, detect it by checking for re-visits.
        const seen = new Set<string>();
        for (const dep of deps) {
          if (seen.has(dep)) {
            return yield* Effect.fail<TaskError>({
              code: "DEPENDENCY_CYCLE",
              message: `Cycle detected: dependency "${dep}" appears more than once in the resolved graph`,
            });
          }
          seen.add(dep);
        }
      }

      const id = crypto.randomUUID();
      const now = Date.now();
      const t: Task = {
        id,
        name: task.name,
        skill: task.skill,
        input: task.input,
        dependencies: deps,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      yield* Ref.update(ref, (m) => new Map(m).set(id, t));
      return id;
    });

  const ready = (): Effect.Effect<readonly Task[]> =>
    Effect.gen(function* () {
      const tasks = yield* list();
      const completedIds = new Set(
        tasks.filter((t) => t.status === "completed").map((t) => t.id)
      );
      return tasks.filter(
        (t) =>
          t.status === "pending" &&
          t.dependencies.every((dep) => completedIds.has(dep))
      );
    });

  const claim = (id: string): Effect.Effect<Task, TaskError> =>
    Effect.gen(function* () {
      const task = yield* get(id);
      if (!task) {
        return yield* Effect.fail({
          code: "TASK_NOT_FOUND" as const,
          message: `Task "${id}" not found`,
        });
      }
      if (task.status !== "pending") {
        return yield* Effect.fail({
          code: "TASK_NOT_PENDING" as const,
          message: `Task "${id}" is "${task.status}", expected "pending"`,
        });
      }
      yield* update(id, { status: "in_progress" });
      return { ...task, status: "in_progress" as const };
    });

  const complete = (id: string, result: SkillContext): Effect.Effect<void> =>
    update(id, { status: "completed", result });

  const fail = (id: string, error: string): Effect.Effect<void> =>
    update(id, { status: "failed", error });

  const stats = (): Effect.Effect<TaskStats> =>
    Effect.map(list(), (tasks) => ({
      pending: tasks.filter((t) => t.status === "pending").length,
      in_progress: tasks.filter((t) => t.status === "in_progress").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      total: tasks.length,
    }));

  const reset = (): Effect.Effect<void> =>
    Ref.set(ref, new Map());

  return { add, get, list, ready, claim, complete, fail, stats, reset };
};

// ── Task Runner ─────────────────────────────────────────────────────────────

export const makeTaskRunner = (
  queue: TaskQueue,
  skills: Map<string, SkillConfig>,
  executorConfig?: SkillExecutorConfig
): TaskRunner => ({
  runAll: (options?: TaskRunnerOptions): Effect.Effect<readonly Task[], SkillError> =>
    Effect.gen(function* () {
      const concurrency =
        options?.concurrency === "unbounded"
          ? ("unbounded" as const)
          : (options?.concurrency ?? 4);

      const runOne = (task: Task): Effect.Effect<void> =>
        Effect.gen(function* () {
          // Claim (skip if already taken by a concurrent wave)
          const claimed = yield* Effect.result(queue.claim(task.id));
          if (claimed._tag === "Failure") return;
          const claimedTask = claimed.success;

          options?.onTaskStart?.(claimedTask);

          const skillConfig = skills.get(task.skill);
          if (!skillConfig) {
            const err = `Skill "${task.skill}" not found in registry`;
            yield* queue.fail(task.id, err);
            options?.onTaskFail?.(claimedTask, err);
            return;
          }

          const executor = yield* makeSkillExecutor(skillConfig, executorConfig);
          const execResult = yield* Effect.result(executor.execute(task.input));

          if (execResult._tag === "Failure") {
            const err = `${execResult.failure.code}: ${execResult.failure.message}`;
            yield* queue.fail(task.id, err);
            options?.onTaskFail?.(claimedTask, err);
          } else {
            yield* queue.complete(task.id, execResult.success);
            const done = yield* queue.get(task.id);
            if (done) options?.onTaskComplete?.(done);
          }
        });

      // Wave loop: run all ready tasks in parallel, repeat until nothing pending
      while (true) {
        const readyTasks = yield* queue.ready();

        if (readyTasks.length === 0) {
          // Fail pending tasks whose deps failed (unresolvable)
          const all = yield* queue.list();
          const failedIds = new Set(
            all.filter((t) => t.status === "failed").map((t) => t.id)
          );
          for (const t of all.filter((t) => t.status === "pending")) {
            const blockedByFailed = t.dependencies.some((d) => failedIds.has(d));
            if (blockedByFailed) {
              yield* queue.fail(
                t.id,
                `Blocked by failed dependencies: ${t.dependencies.filter((d) => failedIds.has(d)).join(", ")}`
              );
            }
          }
          break;
        }

        yield* Effect.all(readyTasks.map(runOne), { concurrency });
      }

      return yield* queue.list();
    }),
});
