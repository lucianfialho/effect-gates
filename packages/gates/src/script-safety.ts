import { Effect } from "effect";

export interface ScriptSafetyConfig {
  /** Block eval() and new Function() constructs (default: true) */
  readonly blockEval?: boolean;
  /** Block process.exit() calls (default: true) */
  readonly blockProcessExit?: boolean;
  /** Block dangerous Node.js module imports (default: true) */
  readonly blockDangerousImports?: boolean;
  /** Custom patterns to block in addition to built-ins */
  readonly additionalBlockedPatterns?: RegExp[];
}

export class ScriptSafetyError {
  readonly _tag = "ScriptSafetyError";
  constructor(
    readonly code: string,
    readonly message: string,
    readonly match?: string
  ) {}
}

// ── Dangerous patterns ────────────────────────────────────────────────────────

const EVAL_PATTERNS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bFunction\s*\(\s*['"`]/,
];

const PROCESS_EXIT_PATTERNS = [
  /\bprocess\.exit\s*\(/,
  /\bprocess\.abort\s*\(/,
  /\bprocess\.kill\s*\(/,
];

const DANGEROUS_IMPORT_PATTERNS = [
  // Child process — can spawn arbitrary commands
  /require\s*\(\s*['"`]child_process['"`]\s*\)/,
  /from\s+['"`]child_process['"`]/,
  /import\s*\(\s*['"`]child_process['"`]\s*\)/,
  // VM — can execute arbitrary code
  /require\s*\(\s*['"`]vm['"`]\s*\)/,
  /from\s+['"`]vm['"`]/,
  // Direct filesystem deletion
  /\.(?:rmdir|rmSync|unlinkSync|rmdirSync)\s*\(/,
];

const TEMPLATE_INJECTION_PATTERNS = [
  // Template literal that could inject arbitrary expressions
  /`[^`]*\$\{[^}]*(?:eval|Function|process|require|import)\s*\(/,
];

// ── Scanner ───────────────────────────────────────────────────────────────────

export const checkScript = (
  script: string,
  config: ScriptSafetyConfig = {}
): Effect.Effect<void, ScriptSafetyError> =>
  Effect.gen(function* () {
    const blockEval = config.blockEval ?? true;
    const blockExit = config.blockProcessExit ?? true;
    const blockImports = config.blockDangerousImports ?? true;
    const additional = config.additionalBlockedPatterns ?? [];

    // Strip comments to avoid false positives
    const stripped = script
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    const checks: Array<{ patterns: RegExp[]; code: string; label: string; enabled: boolean }> = [
      { patterns: EVAL_PATTERNS,             code: "EVAL_DETECTED",          label: "eval() or new Function()",       enabled: blockEval },
      { patterns: PROCESS_EXIT_PATTERNS,     code: "PROCESS_EXIT_DETECTED",  label: "process.exit()",                 enabled: blockExit },
      { patterns: DANGEROUS_IMPORT_PATTERNS, code: "DANGEROUS_IMPORT",       label: "dangerous module import",        enabled: blockImports },
      { patterns: TEMPLATE_INJECTION_PATTERNS, code: "TEMPLATE_INJECTION",   label: "potential template injection",   enabled: true },
      { patterns: additional,                code: "CUSTOM_PATTERN",          label: "blocked pattern",                enabled: true },
    ];

    for (const { patterns, code, label, enabled } of checks) {
      if (!enabled) continue;
      for (const pattern of patterns) {
        const match = stripped.match(pattern);
        if (match) {
          return yield* Effect.fail(
            new ScriptSafetyError(code, `Script blocked: ${label} detected`, match[0])
          );
        }
      }
    }
  });

/**
 * Sanitizes a script by escaping template literals that could cause issues
 * when the script contains code fragments with backticks.
 */
export const sanitizeTemplateLiterals = (script: string): string =>
  // Escape unmatched backticks in string literals
  script.replace(/(?<!\\)`(?![^`]*`)/g, "\\`");

/**
 * Full preprocessing pipeline: check safety then optionally sanitize.
 */
export const preprocessScript = (
  script: string,
  config: ScriptSafetyConfig = {}
): Effect.Effect<string, ScriptSafetyError> =>
  Effect.gen(function* () {
    yield* checkScript(script, config);
    return script;
  });
