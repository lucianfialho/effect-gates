import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import yaml from "js-yaml";
import { defineCommand } from "@gates-effect/runtime";
import type { Tool } from "@gates-effect/runtime";
import type { SkillConfig } from "./types.js";
import { parseSkillYamlContent } from "./discovery.js";

// ── YAML types ──────────────────────────────────────────────────────────────

interface ConnectorCommandYaml {
  name: string;
  description: string;
  executable: string;
  allowedSubcommands?: string[];
  baseArgs?: string[];
  /** Values may contain {{credentials.KEY}} for injection at load time */
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

interface ConnectorManifest {
  name: string;
  description?: string;
  version?: string;
  /** Credential keys this connector needs (informational — warns if missing) */
  requiredCredentials?: string[];
  commands?: ConnectorCommandYaml[];
  skills?: string[];
  docs?: string[];
}

// ── Public types ────────────────────────────────────────────────────────────

export interface Connector {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly path: string;
  readonly tools: Tool[];
  readonly skills: SkillConfig[];
  /** Concatenated content of all docs/ files — inject into prompts as context */
  readonly docs: string;
  readonly missingCredentials: string[];
}

export interface ConnectorRegistry {
  /** All connectors keyed by name */
  readonly connectors: Map<string, Connector>;
  /** Flat map of all tools from all connectors */
  allTools(): Map<string, Tool>;
  /** All skills from all connectors */
  allSkills(): SkillConfig[];
  /** Concatenated docs from all connectors */
  allDocs(): string;
}

// ── Credential interpolation ─────────────────────────────────────────────────

const interpolate = (value: string, credentials: Record<string, string>): string =>
  value.replace(/\{\{credentials\.(\w+)\}\}/g, (_, key) => credentials[key] ?? "");

const interpolateEnv = (
  env: Record<string, string> | undefined,
  credentials: Record<string, string>
): Record<string, string | undefined> => {
  if (!env) return {};
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, interpolate(v, credentials)])
  );
};

// ── Single connector loading ──────────────────────────────────────────────────

export const loadConnector = (
  dirPath: string,
  credentials: Record<string, string> = {}
): Effect.Effect<Connector, Error> =>
  Effect.gen(function* () {
    const manifestPath = path.join(dirPath, "connector.yaml");

    const exists = yield* Effect.tryPromise(() =>
      fs.promises.access(manifestPath).then(() => true).catch(() => false)
    );
    if (!exists) {
      return yield* Effect.fail(new Error(`No connector.yaml found in ${dirPath}`));
    }

    const content = yield* Effect.tryPromise(() => fs.promises.readFile(manifestPath, "utf-8"));
    const manifest = yaml.load(content) as ConnectorManifest;

    // Warn about missing credentials
    const missingCredentials = (manifest.requiredCredentials ?? []).filter(
      (key) => !credentials[key]
    );

    // Build tools from commands
    const tools: Tool[] = (manifest.commands ?? []).map((cmd) =>
      defineCommand({
        name: cmd.name,
        description: cmd.description,
        executable: cmd.executable,
        allowedSubcommands: cmd.allowedSubcommands,
        baseArgs: cmd.baseArgs,
        env: interpolateEnv(cmd.env, credentials) as Record<string, string | undefined>,
        cwd: cmd.cwd,
        timeout: cmd.timeout,
      })
    );

    // Load bundled skills
    const skills: SkillConfig[] = [];
    for (const skillPath of manifest.skills ?? []) {
      const fullPath = path.join(dirPath, skillPath);
      const loaded = yield* Effect.result(
        Effect.tryPromise(() => fs.promises.readFile(fullPath, "utf-8"))
      );
      if (loaded._tag === "Success") {
        skills.push(parseSkillYamlContent(loaded.success));
      }
    }

    // Read bundled docs
    const docParts: string[] = [];
    for (const docPath of manifest.docs ?? []) {
      const fullPath = path.join(dirPath, docPath);
      const loaded = yield* Effect.result(
        Effect.tryPromise(() => fs.promises.readFile(fullPath, "utf-8"))
      );
      if (loaded._tag === "Success") {
        docParts.push(loaded.success);
      }
    }

    return {
      name: manifest.name,
      description: manifest.description ?? "",
      version: manifest.version ?? "1.0",
      path: dirPath,
      tools,
      skills,
      docs: docParts.join("\n\n"),
      missingCredentials,
    };
  });

// ── Discovery ─────────────────────────────────────────────────────────────────

export const loadConnectors = (
  basePath: string,
  credentials: Record<string, string> = {}
): Effect.Effect<ConnectorRegistry, Error> =>
  Effect.gen(function* () {
    const exists = yield* Effect.tryPromise(() =>
      fs.promises.access(basePath).then(() => true).catch(() => false)
    );

    const connectorMap = new Map<string, Connector>();

    if (!exists) {
      return makeRegistry(connectorMap);
    }

    const entries = yield* Effect.tryPromise(() =>
      fs.promises.readdir(basePath, { withFileTypes: true })
    );

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(basePath, entry.name);
      const result = yield* Effect.result(loadConnector(dirPath, credentials));
      if (result._tag === "Success") {
        const connector = result.success;
        connectorMap.set(connector.name, connector);
        if (connector.missingCredentials.length > 0) {
          console.warn(
            `[connector:${connector.name}] missing credentials: ${connector.missingCredentials.join(", ")}`
          );
        }
      } else {
        console.warn(`[connectors] failed to load ${entry.name}: ${result.failure.message}`);
      }
    }

    return makeRegistry(connectorMap);
  });

const makeRegistry = (connectors: Map<string, Connector>): ConnectorRegistry => ({
  connectors,
  allTools: () => {
    const tools = new Map<string, Tool>();
    for (const connector of connectors.values()) {
      for (const tool of connector.tools) {
        tools.set(tool.name, tool);
      }
    }
    return tools;
  },
  allSkills: () => {
    const skills: SkillConfig[] = [];
    for (const connector of connectors.values()) {
      skills.push(...connector.skills);
    }
    return skills;
  },
  allDocs: () =>
    [...connectors.values()]
      .filter((c) => c.docs)
      .map((c) => `## ${c.name}\n\n${c.docs}`)
      .join("\n\n---\n\n"),
});
