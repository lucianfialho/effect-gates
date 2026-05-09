#!/usr/bin/env node
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import { discoverHarnesses } from "./harness/loader.js";
import { startServer, DEFAULT_PORT } from "./server/index.js";
import { App } from "./tui/app.js";

const program = new Command();

program
  .name("harness-ui")
  .description("Terminal UI for gates-effect harnesses")
  .version("0.1.0");

program
  .command("start", { isDefault: true })
  .description("Start harness-ui (server + TUI)")
  .option("-p, --port <number>", "Server port", String(DEFAULT_PORT))
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("--server-only", "Start HTTP server only (no TUI)", false)
  .action(async (options) => {
    const port = Number(options.port);
    const { resolve } = await import("path");
    const dir = resolve(process.cwd(), options.dir as string);

    process.chdir(dir);

    const harnesses = await discoverHarnesses(dir);
    if (harnesses.length === 0) {
      console.error("No harnesses found. Create one in .gates/harnesses/");
      process.exit(1);
    }

    const stopServer = await startServer(harnesses, port);
    await new Promise((r) => setTimeout(r, 100));

    const isTTY = process.stdin.isTTY;
    if (options.serverOnly || !isTTY) {
      console.log(`harness-ui server running on http://localhost:${port}`);
      console.log(`Harnesses: ${harnesses.map((h) => h.name).join(", ")}`);
      console.log("Press Ctrl+C to stop.");
      process.on("SIGINT", () => { stopServer(); process.exit(0); });
      return; // keep process alive
    }

    const { waitUntilExit } = render(React.createElement(App, { harnesses }));
    await waitUntilExit();
    stopServer();
    process.exit(0);
  });

program
  .command("list")
  .description("List available harnesses")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .action(async (options) => {
    const harnesses = await discoverHarnesses(options.dir as string);
    if (harnesses.length === 0) {
      console.log("No harnesses found.");
      return;
    }
    console.log(`Found ${harnesses.length} harness(es):\n`);
    for (const h of harnesses) {
      console.log(`  ${h.name}`);
      if (h.config.description) console.log(`    ${h.config.description}`);
      console.log(`    provider: ${h.config.provider.type}${h.config.provider.model ? `/${h.config.provider.model}` : ""}`);
      console.log();
    }
  });

program.parse();
