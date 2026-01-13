#!/usr/bin/env bun

import { Command } from "commander";
import { initCommand } from "./commands/init";
import { trainCommand } from "./commands/train";
import { scanCommand } from "./commands/scan";
import {
  approveCommand,
  approveMatchCommand,
  rejectMatchCommand,
  addMatchCommand,
} from "./commands/approve";
import { statusCommand } from "./commands/status";
import { listCommand } from "./commands/list";
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
  .description("Scan photos and create review albums")
  .argument("[path]", "Path to scan")
  .option("-s, --source <type>", "Source type (local)", "local")
  .option("-p, --path <path>", "Path to scan (alternative to argument)")
  .option("--dry-run", "Show what would be done without making changes")
  .option("--rescan", "Force re-scan of cached photos")
  .option("-l, --limit <number>", "Limit number of new photos to scan", parseInt)
  .option("-f, --filter <regex>", "Filter files by regex pattern (matches filename)")
  .option("-v, --verbose", "Show list of scanned files")
  .action((path, options) => scanCommand({ ...options, path: path || options.path }));

program
  .command("approve")
  .description("Approve review albums and move photos to final albums")
  .option("--person <name>", "Person name to approve match for")
  .option("--photo <path>", "Photo path to approve")
  .option("--all", "Approve all matches for the person")
  .action((options) => {
    if (options.person) {
      return approveMatchCommand(options);
    }
    return approveCommand();
  });

program
  .command("reject")
  .description("Mark a recognition as incorrect (false positive)")
  .requiredOption("--person <name>", "Person name")
  .requiredOption("--photo <path>", "Photo path")
  .action(rejectMatchCommand);

program
  .command("add-match")
  .description("Manually add a person to a photo (for missed detections)")
  .requiredOption("--person <name>", "Person name")
  .requiredOption("--photo <path>", "Photo path")
  .action(addMatchCommand);

program
  .command("status")
  .description("Show collection info and stats")
  .action(statusCommand);

program
  .command("list")
  .description("List photos from the latest scan")
  .action(listCommand);

program
  .command("cleanup")
  .description("Remove collection and reset")
  .option("--force", "Skip confirmation")
  .action(cleanupCommand);

program.parse();
