#!/usr/bin/env bun

import { Command } from "commander";
import { initCommand } from "./commands/init";
import { trainCommand, trainShowCommand } from "./commands/train";
import {
  scanCommand,
  scanListHistoryCommand,
  scanShowCommand,
  scanClearCommand,
} from "./commands/scan";
import {
  photosListCommand,
  photosApproveCommand,
  photosRejectCommand,
  photosAddCommand,
  photosExportCommand,
} from "./commands/photos";
import { statusCommand } from "./commands/status";
import { cleanupCommand } from "./commands/cleanup";
import { clearCommand } from "./commands/clear";

const program = new Command();

program
  .name("claude-book")
  .description("CLI tool for organizing family photos using face recognition")
  .version("0.1.0")
  .enablePositionalOptions();

program
  .command("init")
  .description("Initialize config and AWS Rekognition collection")
  .action(initCommand);

// Train command with subcommands
const train = program
  .command("train")
  .description("Index faces from reference folders")
  .argument("[path]", "Path to references folder")
  .option("-r, --references <path>", "Path to references folder (deprecated, use positional)")
  .action(trainCommand);

train
  .command("show")
  .description("Show reference photos for a person")
  .argument("<person>", "Person name")
  .option("-o, --open", "Open photos in Preview")
  .action(trainShowCommand);

train
  .command("cleanup")
  .description("Remove AWS Rekognition collection")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(cleanupCommand);

// Parse date string (YYYY-MM-DD) to Date
function parseDate(value: string): Date {
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD format.`);
  }
  return date;
}

// Scan command - primary action is scanning, subcommands for history
const scan = program
  .command("scan")
  .description("Scan photos and manage scan history")
  .argument("[path]", "Path to scan")
  .option("-p, --path <path>", "Path to scan (deprecated, use positional)")
  .option("--dry-run", "Show what would be done without making changes")
  .option("--rescan", "Force re-scan of cached photos")
  .option("-l, --limit <number>", "Limit number of new photos to scan", parseInt)
  .option("-f, --filter <regex>", "Filter files by regex pattern (matches filename)")
  .option("-e, --exclude <pattern...>", "Exclude files containing pattern in filename")
  .option("--after <date>", "Only include photos after date (YYYY-MM-DD)", parseDate)
  .option("--before <date>", "Only include photos before date (YYYY-MM-DD)", parseDate)
  .option("-v, --verbose", "Show list of scanned files")
  .option("--report", "Show photos report after scan completes")
  .action((path, options) => scanCommand({ ...options, path: path || options.path }));

scan
  .command("list")
  .description("List recent scans with stats")
  .option("-l, --limit <number>", "Number of scans to show", parseInt)
  .option("-o, --open", "Open photos from latest scan in Preview")
  .option("--json", "Output as JSON")
  .action(scanListHistoryCommand);

scan
  .command("show")
  .description("Show details for a specific scan")
  .argument("<id>", "Scan ID")
  .option("-o, --open", "Open photos in Preview")
  .option("--json", "Output as JSON")
  .action(scanShowCommand);

scan
  .command("clear")
  .description("Clear all scan history and reset photo recognitions")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(scanClearCommand);

// Photos command group
const photos = program
  .command("photos")
  .description("List, review, and export recognized photos")
  .passThroughOptions()
  .option("--person <name>", "Filter by person name (use 'all' for any recognized)")
  .option("--status <status>", "Filter by status (pending, approved, rejected, manual, all)")
  .option("--scan <id>", "Filter by scan ID (use 'latest' for most recent)")
  .option("--min-confidence <n>", "Filter photos with confidence >= n%", parseInt)
  .option("--max-confidence <n>", "Filter photos with confidence <= n%", parseInt)
  .option("-o, --open", "Open photos in Preview")
  .option("-l, --limit <number>", "Limit results", parseInt)
  .option("--offset <number>", "Skip first n results", parseInt)
  .option("--json", "Output as JSON")
  .action(photosListCommand);

photos
  .command("approve")
  .description("Approve photo recognitions")
  .argument("[indexesOrPerson]", "Indexes (1,2,4-6) or person name")
  .argument("[path]", "Photo path (when using person name)")
  .option("--all", "Approve all in current list")
  .option("--without <indexes>", "Exclude these indexes when using --all")
  .option("--min-confidence <n>", "Filter by confidence >= n% (with --all)", parseInt)
  .option("--max-confidence <n>", "Filter by confidence <= n% (with --all)", parseInt)
  .option("--person <name>", "Filter by person")
  .option("--dry-run", "Preview without making changes")
  .action(photosApproveCommand);

photos
  .command("reject")
  .description("Reject photo recognitions (mark as false positive)")
  .argument("[indexesOrPerson]", "Indexes (1,2,4-6) or person name")
  .argument("[path]", "Photo path (when using person name)")
  .option("--all", "Reject all in current list")
  .option("--without <indexes>", "Exclude these indexes when using --all")
  .option("--min-confidence <n>", "Filter by confidence >= n% (with --all)", parseInt)
  .option("--max-confidence <n>", "Filter by confidence <= n%", parseInt)
  .option("--person <name>", "Filter by person")
  .option("--file <filename>", "Reject by filename (must match exactly 1 photo)")
  .option("--dry-run", "Preview without making changes")
  .action(photosRejectCommand);

photos
  .command("add")
  .description("Manually add person to photo (false negative correction)")
  .argument("<person>", "Person name")
  .argument("<path>", "Photo path")
  .action(photosAddCommand);

photos
  .command("export")
  .description("Export approved photos to Apple Photos albums")
  .option("--person <name>", "Export only for specific person")
  .option("--album <name>", "Custom album name")
  .action(photosExportCommand);

program
  .command("status")
  .description("Show collection info and stats")
  .action(statusCommand);

program
  .command("clear")
  .description("Clear all photos from database (keeps training data)")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(clearCommand);

program.parse();
