#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderText, scan } from "../src/core.mjs";
import { CLIENT_IDS, RULESETS } from "../src/rules.mjs";

const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const VERSION = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")).version;

function usage() {
  return [
    "agent-context-map [target] [options]",
    "",
    "Predict which repository instruction files may apply to a target path.",
    "",
    "Arguments:",
    "  target                     File or directory, relative to the launch directory.",
    "",
    "Options:",
    "  --agent <id|all>           codex, claude, cursor, or all. Default: all.",
    "  --launch-dir <path>        Directory from which the client starts. Default: current directory.",
    "  --root <path>              Repository root. Default: nearest .git directory.",
    "  --claude-mode <mode>       default, both, or claude-only. Default: default.",
    "  --json                     Print structured decisions and ruleset sources.",
    "  --version                  Print the package version.",
    "  --help                     Show this help.",
    "",
    "Results describe repository-local files under dated documentation rulesets.",
    "The command does not inspect a live session, account settings, or hidden context.",
    "",
    "Rulesets:",
    ...CLIENT_IDS.map((id) => "  " + id.padEnd(8) + " " + RULESETS[id].name + " (" + RULESETS[id].id + ")"),
    "",
    "Sources:",
    ...CLIENT_IDS.map((id) => "  " + RULESETS[id].name + ": " + RULESETS[id].source),
  ].join("\n");
}

function parseArgs(args) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--json") options.json = true;
    else if (["--agent", "--launch-dir", "--root", "--claude-mode"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(arg + " requires a value.");
      options[arg.slice(2).replaceAll("-", "")] = value;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error("Unknown option: " + arg);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) throw new Error("Provide at most one target path.");
  options.target = positionals[0] || ".";
  options.launchDir = options.launchdir;
  options.claudeMode = options.claudemode;
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage() + "\n");
      return;
    }
    if (options.version) {
      process.stdout.write(VERSION + "\n");
      return;
    }
    const result = scan(options);
    process.stdout.write(options.json
      ? JSON.stringify(result, null, 2) + "\n"
      : renderText(result) + "\n");
  } catch (error) {
    process.stderr.write("error: " + error.message + "\nRun agent-context-map --help for usage.\n");
    process.exitCode = 2;
  }
}

main();
