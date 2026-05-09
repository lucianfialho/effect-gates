import { Command } from "commander";
import { run } from "./commands/run.js";
import { chat } from "./commands/chat.js";
import { resume } from "./commands/resume.js";
import { login, connect } from "./commands/login.js";
import { sessions } from "./commands/sessions.js";
import { dev } from "./commands/dev.js";
import { runSkill, parseSkillInput, findSkillPath } from "./commands/run-skill.js";

const program = new Command();

program
  .name("gates")
  .description("Gates Effect - AI Agent Framework in pure Effect")
  .version("0.1.0");

program
  .command("run <prompt>")
  .description("Run a one-shot agent prompt")
  .option("-p, --provider <provider>", "Provider (minimax, anthropic, openai)", "minimax")
  .option("-m, --model <model>", "Model to use")
  .option("-t, --temperature <number>", "Temperature", "0.7")
  .option("--tools", "Enable tool calling", false)
  .option("-i, --max-iterations <number>", "Max tool iterations", "10")
  .action(run);

program
  .command("chat")
  .description("Start an interactive chat session")
  .option("-s, --session <id>", "Session ID", "default")
  .option("-p, --provider <provider>", "Provider (minimax, anthropic, openai)", "minimax")
  .option("-m, --model <model>", "Model to use")
  .action(chat);

program
  .command("resume <session-id> <prompt>")
  .description("Resume an existing session")
  .option("-p, --provider <provider>", "Provider (minimax, anthropic, openai)", "minimax")
  .option("-m, --model <model>", "Model to use")
  .action(resume);

program
  .command("login")
  .description("Login to a provider")
  .option("-p, --provider <provider>", "Provider (minimax, anthropic, openai)")
  .option("-k, --key <key>", "API key")
  .action(login);

program
  .command("connect")
  .description("Interactive provider connection wizard")
  .action(connect);

program
  .command("sessions")
  .description("List saved sessions")
  .option("-a, --all", "Show detailed info for all sessions")
  .action(sessions);

program
  .command("dev <prompt>")
  .description("Run agent with tools in dev mode (with optional file watching)")
  .option("-w, --watch <patterns>", "File patterns to watch (comma-separated)")
  .option("-p, --provider <provider>", "Provider (minimax, anthropic, openai)", "minimax")
  .option("-m, --model <model>", "Model to use")
  .option("-i, --max-iterations <number>", "Max tool iterations", "10")
  .action(dev);

program
  .command("skill <name>")
  .description("Run a skill from .gates/skills/")
  .option("-i, --input <json>", "Input as JSON string")
  .option("-s, --sandbox <type>", "Sandbox type (memory, local)", "local")
  .option("-p, --path <path>", "Base path for skills (default: process.cwd())")
  .option("-k, --api-key <key>", "API key for LLM calls")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (name, options) => {
    const basePath = options.path ?? process.env.GATES_BASE ?? process.cwd();
    const skillPath = findSkillPath(name, basePath);
    const input = options.input ? parseSkillInput(options.input) : {};
    await runSkill({
      skillPath,
      input,
      sandboxType: options.sandbox as "memory" | "local" ?? "local",
      verbose: options.verbose ?? false,
      apiKey: options.apiKey ?? process.env.MINIMAX_API_KEY,
    });
  });

program.parse();