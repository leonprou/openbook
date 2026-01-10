#!/usr/bin/env bun

import { Command } from "commander";
import { initCommand } from "./commands/init";
import { trainCommand } from "./commands/train";
import { scanCommand } from "./commands/scan";
import { statusCommand } from "./commands/status";
import { cleanupCommand } from "./commands/cleanup";

const program = new Command();

program
  .name("claude-book")
  .description("CLI tool for organizing family photos using face recognition")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize config and AWS Rekognition collection")
  .action(initCommand);

program
  .command("train")
  .description("Index faces from reference folders")
  .option("-r, --references <path>", "Path to references folder")
  .action(trainCommand);

program
  .command("scan")
  .description("Scan photos and organize into Apple Photos albums")
  .option("-s, --source <type>", "Source type (local)", "local")
  .option("-p, --path <path>", "Path to scan")
  .option("--dry-run", "Show what would be done without making changes")
  .action(scanCommand);

program
  .command("status")
  .description("Show collection info and stats")
  .action(statusCommand);

program
  .command("cleanup")
  .description("Remove collection and reset")
  .option("--force", "Skip confirmation")
  .action(cleanupCommand);

program.parse();
