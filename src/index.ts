#!/usr/bin/env bun

import { Command } from "commander";
import { initCommand } from "./commands/init";
import { trainCommand, trainShowCommand } from "./commands/train";
import {
  scanCommand,
  scanListHistoryCommand,
  scanShowCommand,
  scanClearCommand,
  scanUncacheCommand,
} from "./commands/scan";
import {
  photosListCommand,
  photosApproveCommand,
  photosRejectCommand,
  photosAddCommand,
  photosExportCommand,
} from "./commands/photos";
import { statusCommand } from "./commands/status";
import { statsCommand } from "./commands/stats";
import { personsListCommand, personsShowCommand } from "./commands/persons";
import { cleanupCommand } from "./commands/cleanup";
import { clearCommand } from "./commands/clear";

const program = new Command();

program
  .name("openbook")
  .description("CLI tool for organizing family photos using face recognition")
  .version("0.1.0")
  .enablePositionalOptions();

program
  .command("init")
  .description("Initialize config and AWS Rekognition collection")
  .option("--local", "Create config in current directory instead of global location")
  .action(initCommand);

// Train command with subcommands
const train = program
  .command("train")
  .description("Index faces from reference folders")
  .argument("[path]", "Path to references folder")
  .option("--path <path>", "Path to references folder (overrides config)")
  .option("-r, --references <path>", "Path to references folder (deprecated, use --path)")
  .option("--person <name>", "Train only a specific person")
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
  .option("--file <path...>", "Scan specific files by path")
  .option("--dry-run", "Show what would be done without making changes")
  .option("--rescan", "Force re-scan of cached photos")
  .option("-l, --limit <number>", "Limit number of new photos to scan", parseInt)
  .option("-f, --filter <regex>", "Filter files by regex pattern (matches filename)")
  .option("-e, --exclude <pattern...>", "Exclude files containing pattern in filename")
  .option("--after <date>", "Only include photos after date (YYYY-MM-DD)", parseDate)
  .option("--before <date>", "Only include photos before date (YYYY-MM-DD)", parseDate)
  .option("--person <name>", "Filter report to specific person (implies --report)")
  .option("-v, --verbose", "Show list of scanned files")
  .option("--debug", "Show raw AWS Rekognition API responses")
  .option("--report", "Show photos report after scan completes")
  .action((path, options) => scanCommand({ ...options, path }));

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

scan
  .command("uncache")
  .description("Remove directory from cache (will be re-scanned next time)")
  .argument("<path>", "Directory path to uncache")
  .action((path) => scanUncacheCommand(path));

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
  .option("--after <date>", "Only include photos after date (YYYY-MM-DD)", parseDate)
  .option("--before <date>", "Only include photos before date (YYYY-MM-DD)", parseDate)
  .option("--file <name>", "Filter by filename (substring match)")
  .option("-o, --open", "Open photos in Preview")
  .option("-l, --limit <number>", "Limit results", parseInt)
  .option("--offset <number>", "Skip first n results", parseInt)
  .option("-p, --page <number>", "Page number (1-indexed)", parseInt)
  .option("--per-page <number>", "Results per page (default: from config)", parseInt)
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
  .option("--scan <id>", "Filter by scan ID (use 'latest' for most recent)")
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
  .description("Export approved photos to folders or Apple Photos")
  .option("--person <name>", "Export only for specific person")
  .option("--album <name>", "Custom album name (Apple Photos only)")
  .option("--backend <type>", "Export backend: folder (default) or apple-photos")
  .option("--output <path>", "Output directory (folder backend only)")
  .option("--copy", "Copy files instead of creating symlinks (folder backend)")
  .option("--dry-run", "Preview without exporting")
  .action(photosExportCommand);

program
  .command("status")
  .description("Show collection info and stats")
  .action(statusCommand);

program
  .command("stats")
  .description("Show classification accuracy metrics")
  .action(statsCommand);

// Persons command
const persons = program
  .command("persons")
  .description("List people and their recognition stats")
  .option("--json", "Output as JSON")
  .action(personsListCommand);

persons
  .command("show")
  .description("Show detailed info for a person")
  .argument("<name>", "Person name")
  .option("--json", "Output as JSON")
  .action(personsShowCommand);

program
  .command("clear")
  .description("Clear all photos from database (keeps training data)")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(clearCommand);

program.parse();
