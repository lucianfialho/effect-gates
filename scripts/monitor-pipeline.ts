/**
 * pipeline-monitor — watches ~/.gates/sessions/ for new harness-ui_* sessions
 * and prints a live status table.
 *
 * Usage: npx tsx scripts/monitor-pipeline.ts
 * Runs until Ctrl+C.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

const SESSIONS_DIR = path.join(os.homedir(), ".gates", "sessions");
const POLL_INTERVAL_MS = 10_000;

// ── Types ──────────────────────────────────────────────────────────────────────

interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

interface SessionEntry {
  type: string;
  id: string;
  timestamp: string;
  message?: SessionMessage;
  source?: string;
}

interface SessionFile {
  version: number;
  entries: SessionEntry[];
  metadata?: {
    sessionId?: string;
    harnessName?: string;
  };
  createdAt?: string;
  updatedAt?: string;
}

interface SessionStatus {
  sessionId: string;
  task: string;
  status: "ok" | "fail" | "running" | "unknown";
  filesChanged: string;
  build: "pass" | "fail" | "unknown";
  updatedAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function readSessionFile(filePath: string): SessionFile | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SessionFile;
  } catch {
    return null;
  }
}

function extractFirstUserMessage(entries: SessionEntry[]): string {
  const entry = entries.find(
    (e) => e.type === "message" && e.message?.role === "user"
  );
  const content = entry?.message?.content ?? "";
  return content.length > 60 ? content.slice(0, 57) + "..." : content;
}

function detectStatus(entries: SessionEntry[]): "ok" | "fail" | "running" | "unknown" {
  const messages = entries
    .filter((e) => e.type === "message" && e.message?.role === "assistant")
    .map((e) => e.message?.content ?? "");

  if (messages.length === 0) return "running";

  const last = messages[messages.length - 1]!.toLowerCase();

  const failPatterns = [
    "error:", "failed", "exception", "build failed",
    "tsc error", "compilation error", "unable to", "cannot",
  ];
  const okPatterns = [
    "completed", "done", "success", "passed", "committed",
    "pipeline completed", "all tasks",
  ];

  if (failPatterns.some((p) => last.includes(p))) return "fail";
  if (okPatterns.some((p) => last.includes(p))) return "ok";

  return "unknown";
}

function detectBuildStatus(entries: SessionEntry[]): "pass" | "fail" | "unknown" {
  const assistantMessages = entries
    .filter((e) => e.type === "message" && e.message?.role === "assistant")
    .map((e) => e.message?.content ?? "");

  for (const msg of assistantMessages.reverse()) {
    const lower = msg.toLowerCase();
    if (lower.includes("build pass") || lower.includes("tsc: 0 errors") || lower.includes("no errors")) return "pass";
    if (lower.includes("build fail") || lower.includes("tsc error") || lower.includes("error ts")) return "fail";
  }
  return "unknown";
}

function getGitFilesChanged(workDir?: string): string {
  if (!workDir) return "?";
  try {
    const out = execSync("git diff --stat HEAD 2>/dev/null | tail -1", {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (!out) return "0";
    const match = out.match(/(\d+) file/);
    return match ? match[1]! : "?";
  } catch {
    return "?";
  }
}

function formatRow(s: SessionStatus): string {
  const id = s.sessionId.slice(0, 8);
  const task = s.task.padEnd(40);
  const status = s.status === "ok"
    ? " ok  "
    : s.status === "fail"
    ? "FAIL "
    : s.status === "running"
    ? " ...  "
    : "  ?  ";
  const files = s.filesChanged.padStart(6);
  const build = s.build === "pass" ? "PASS" : s.build === "fail" ? "FAIL" : "  ? ";
  const upd = s.updatedAt.slice(11, 19); // HH:MM:SS
  return `${id}  ${task}  ${status}  ${files}  ${build}  ${upd}`;
}

function printTable(rows: SessionStatus[]): void {
  const header =
    "session   task                                       status  files  build  time   ";
  const sep = "-".repeat(header.length);
  console.clear();
  console.log("pipeline-monitor — watching ~/.gates/sessions/  (Ctrl+C to exit)\n");
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    console.log(formatRow(row));
  }
  if (rows.length === 0) {
    console.log("(no harness-ui sessions found yet)");
  }
  console.log(sep);
  console.log(`Last poll: ${new Date().toISOString()}  Interval: ${POLL_INTERVAL_MS / 1000}s`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

function getSessionFiles(): string[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.startsWith("harness-ui_") && f.endsWith(".json"))
    .map((f) => path.join(SESSIONS_DIR, f));
}

function buildStatus(filePath: string): SessionStatus {
  const session = readSessionFile(filePath);
  const sessionId = path.basename(filePath, ".json").replace("harness-ui_", "");

  if (!session) {
    return {
      sessionId,
      task: "(unreadable)",
      status: "unknown",
      filesChanged: "?",
      build: "unknown",
      updatedAt: new Date().toISOString(),
    };
  }

  const task = extractFirstUserMessage(session.entries);
  const status = detectStatus(session.entries);
  const build = detectBuildStatus(session.entries);
  const filesChanged = getGitFilesChanged();
  const updatedAt = session.updatedAt ?? new Date().toISOString();

  return { sessionId, task, status, filesChanged, build, updatedAt };
}

// Track which sessions we've seen (by file mtime) so we only re-parse changed ones
const cache = new Map<string, { mtime: number; status: SessionStatus }>();

function poll(): SessionStatus[] {
  const files = getSessionFiles();
  const results: SessionStatus[] = [];

  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      const mtime = stat.mtimeMs;
      const cached = cache.get(filePath);

      if (cached && cached.mtime === mtime) {
        results.push(cached.status);
      } else {
        const status = buildStatus(filePath);
        cache.set(filePath, { mtime, status });
        results.push(status);
      }
    } catch {
      // file disappeared between readdir and stat — skip
    }
  }

  // Sort by updatedAt descending (newest first)
  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return results;
}

// ── Entry point ───────────────────────────────────────────────────────────────

console.log("Starting pipeline-monitor...");

if (!fs.existsSync(SESSIONS_DIR)) {
  console.error(`Sessions directory not found: ${SESSIONS_DIR}`);
  console.error("Run at least one gates harness session first.");
  process.exit(1);
}

function tick() {
  const rows = poll();
  printTable(rows);
}

tick();
const interval = setInterval(tick, POLL_INTERVAL_MS);

process.on("SIGINT", () => {
  clearInterval(interval);
  console.log("\nExiting pipeline-monitor.");
  process.exit(0);
});
