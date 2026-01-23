import ora from "ora";
import cliProgress from "cli-progress";
import { loadConfig } from "../config";
import { FaceRecognitionClient } from "../rekognition/client";
import { confirm } from "../utils/confirm";
import { printPhotoTable, type PhotoRow } from "../utils/table";
import { LocalPhotoSource, extractDateFromFilename, type DirectoryChecker } from "../sources/local";
import { PhotoScanner, type PhotoMatch, type VerboseInfo } from "../pipeline/scanner";
import { photosListCommand } from "./photos";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { resolve, basename, dirname } from "path";
import { homedir } from "os";
import {
  initDatabase,
  createScan,
  completeScan,
  updateAllPersonPhotoCounts,
  getLastScan,
  getScanById,
  getRecentScans,
  getPhotosByScan,
  addCorrection,
  clearAllScans,
  getDirectoryCache,
  saveDirectoryCache,
  removeDirectoryCache,
  type Photo,
  type Scan,
} from "../db";

interface ScanOptions {
  source?: string;
  path?: string;
  dryRun?: boolean;
  rescan?: boolean;
  limit?: number;
  filter?: string;
  exclude?: string[];
  after?: Date;
  before?: Date;
  person?: string;
  verbose?: boolean;
  report?: boolean;
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Calculate average confidence for a person's matches
 */
function calculateAvgConfidence(matches: PhotoMatch[]): number {
  if (matches.length === 0) return 0;

  let totalConfidence = 0;
  let count = 0;

  for (const match of matches) {
    for (const m of match.matches) {
      totalConfidence += m.confidence;
      count++;
    }
  }

  return count > 0 ? totalConfidence / count : 0;
}

export async function scanCommand(options: ScanOptions): Promise<void> {
  const config = loadConfig();
  const spinner = ora();

  // Deprecation warning for old syntax
  if (options.path && !process.argv.includes(options.path)) {
    // Only show if -p was used (not positional)
    const hasPathFlag = process.argv.includes("-p") || process.argv.includes("--path");
    if (hasPathFlag) {
      console.warn("Warning: -p/--path is deprecated. Use positional argument instead:");
      console.warn("  claude-book scan <path>");
      console.warn("");
    }
  }

  // --person implies --report
  if (options.person) {
    options.report = true;
  }

  // Initialize database
  spinner.start("Initializing database...");
  initDatabase();
  spinner.succeed("Database initialized");

  // Determine paths to scan
  let paths: string[];
  if (options.path) {
    paths = [expandPath(options.path)];
  } else {
    paths = config.sources.local.paths;
  }

  if (paths.length === 0) {
    spinner.fail("No paths to scan. Use --path or configure sources.local.paths in config.yaml");
    process.exit(1);
  }

  // Validate paths exist
  for (const p of paths) {
    if (!existsSync(p)) {
      spinner.fail(`Path not found: ${p}`);
      process.exit(1);
    }
  }

  // Check collection exists
  spinner.start("Checking face collection...");
  const client = new FaceRecognitionClient(config);

  const collectionInfo = await client.getCollectionInfo();
  if (!collectionInfo || collectionInfo.faceCount === 0) {
    spinner.fail("No faces indexed. Run 'claude-book train' first.");
    process.exit(1);
  }

  // Show collection info with search method
  const searchMethod = config.rekognition.searchMethod;
  const userInfo = collectionInfo.userCount > 0 ? `, ${collectionInfo.userCount} users` : "";
  spinner.succeed(`Collection: ${collectionInfo.faceCount} faces${userInfo} [searchMethod: ${searchMethod}]`);

  // Build source options (limit is handled by scanner for new scans only)
  // Directory checker skips unchanged directories (read-only for count phase)
  const readOnlyChecker: DirectoryChecker | undefined = options.rescan ? undefined : {
    shouldSkip(dirPath: string, mtimeMs: number) {
      const cached = getDirectoryCache(dirPath);
      return (cached && cached.mtimeMs === mtimeMs) ? cached.fileCount : null;
    },
    onScanned() { /* no-op during count */ },
  };

  const sourceOptions = {
    filter: options.filter ? new RegExp(options.filter) : undefined,
    exclude: options.exclude,
    after: options.after,
    before: options.before,
    maxSortBuffer: config.scanning.maxSortBuffer,
    directoryChecker: readOnlyChecker,
  };

  // Count photos
  spinner.start("Counting photos...");
  const source = new LocalPhotoSource(paths, config.sources.local.extensions, sourceOptions);
  const totalPhotos = await source.count();
  const cachedDirFiles = source.skippedFiles;
  const cachedDirCount = source.skippedDirs;
  const newDirCount = source.walkedDirs;

  if (totalPhotos === 0 && cachedDirFiles === 0) {
    spinner.fail("No photos found in the specified paths");
    if (options.filter) {
      console.error(`  Filter applied: ${options.filter}`);
    }
    if (options.exclude?.length) {
      console.error(`  Exclude patterns: ${options.exclude.join(", ")}`);
    }
    process.exit(1);
  }

  if (totalPhotos === 0 && cachedDirFiles > 0) {
    spinner.succeed(`All ${cachedDirFiles} photos in ${cachedDirCount} directories unchanged (use --rescan to force)`);
    return;
  }

  // Dry run: show count and files table, then exit (no DB writes or AWS calls)
  if (options.dryRun) {
    let foundMessage = `Found ${totalPhotos} photos`;
    if (options.filter || options.exclude?.length || options.after || options.before) {
      const parts: string[] = [];
      if (options.filter) parts.push(`filter: ${options.filter}`);
      if (options.exclude?.length) parts.push(`exclude: ${options.exclude.join(", ")}`);
      if (options.after) parts.push(`after: ${options.after.toISOString().split("T")[0]}`);
      if (options.before) parts.push(`before: ${options.before.toISOString().split("T")[0]}`);
      foundMessage += ` (${parts.join(", ")})`;
    }
    spinner.succeed(foundMessage);

    // Show files that would be scanned
    const limit = config.display.photoLimit;
    const files: { path: string; date: Date }[] = [];
    for await (const photo of source.scan()) {
      const date = extractDateFromFilename(photo.filename) ?? photo.modifiedAt;
      files.push({ path: photo.path, date });
      if (files.length >= limit) break;
    }

    if (files.length > 0) {
      // Directory summary
      const dirCounts = new Map<string, number>();
      for (const f of files) {
        const folder = dirname(f.path).split("/").slice(-2).join("/");
        dirCounts.set(folder, (dirCounts.get(folder) ?? 0) + 1);
      }
      const maxDirLen = Math.max(...[...dirCounts.keys()].map((d) => d.length));
      console.log("\nDirectories:");
      for (const [dir, count] of [...dirCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${dir.padEnd(maxDirLen + 2)}${String(count).padStart(3)} photos`);
      }

      console.log("\nFiles to scan:");
      console.log(" #    Date        Folder                          Filename");
      console.log("─".repeat(95));
      files.forEach((f, i) => {
        const dateStr = f.date.toISOString().split("T")[0];
        const folder = dirname(f.path).split("/").slice(-2).join("/");
        const filename = basename(f.path);
        const folderTrunc = folder.length > 30 ? folder.slice(0, 27) + "..." : folder.padEnd(30);
        console.log(`${String(i + 1).padStart(4)}  ${dateStr}  ${folderTrunc}  ${filename}`);
      });
      if (totalPhotos > limit) {
        console.log(`\n... and ${totalPhotos - limit} more files`);
      }
    }

    console.log("\n[Dry run] No changes made.");
    return;
  }

  // Create scan record first so we can show the ID
  const scanId = createScan(paths);

  let foundMessage = `[Scan #${scanId}] Found ${totalPhotos} photos`;
  const parts: string[] = [];
  if (options.filter) parts.push(`filter: ${options.filter}`);
  if (options.exclude?.length) parts.push(`exclude: ${options.exclude.join(", ")}`);
  if (options.after) parts.push(`after: ${options.after.toISOString().split("T")[0]}`);
  if (options.before) parts.push(`before: ${options.before.toISOString().split("T")[0]}`);
  if (options.limit) parts.push(`limit: ${options.limit} new`);
  if (parts.length > 0) foundMessage += ` (${parts.join(", ")})`;
  spinner.succeed(foundMessage);

  // Show directory cache breakdown when there are cached directories
  if (cachedDirCount > 0) {
    const dirParts: string[] = [];
    dirParts.push(`${cachedDirCount} dirs unchanged (${cachedDirFiles} photos)`);
    if (newDirCount > 0) {
      dirParts.push(`${newDirCount} new dirs (${totalPhotos} photos to scan)`);
    }
    console.log(`  ${dirParts.join(", ")}`);
  }

  // Scan photos with caching
  // When limit is set, progress bar tracks new scans toward the limit
  // Otherwise, it tracks total photos processed
  const progressTotal = options.limit ?? totalPhotos;
  const useNewScansProgress = !!options.limit;

  const progressBar = new cliProgress.SingleBar(
    {
      format: useNewScansProgress
        ? "Scanning |{bar}| {percentage}% | {value}/{total} new | Matched: {matched} | {file}"
        : "Scanning |{bar}| {percentage}% | {value}/{total} | Matched: {matched} | Cached: {cached} | {file}",
      barsize: config.display.progressBarWidth,
    },
    cliProgress.Presets.shades_classic
  );

  progressBar.start(progressTotal, 0, { matched: 0, cached: 0, file: "" });

  const scanner = new PhotoScanner(
    client,
    config.rekognition.minConfidence,
    config.rekognition.searchMethod
  );

  // Validate that training matches the configured search method
  try {
    scanner.validateSearchMode();
  } catch (error: any) {
    progressBar.stop();
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  }

  // Collect directory cache entries in memory; only persist on successful completion
  const pendingDirCache: Array<{ dirPath: string; mtimeMs: number; fileCount: number }> = [];
  const scanChecker: DirectoryChecker | undefined = options.rescan ? undefined : {
    shouldSkip(dirPath: string, mtimeMs: number) {
      const cached = getDirectoryCache(dirPath);
      return (cached && cached.mtimeMs === mtimeMs) ? cached.fileCount : null;
    },
    onScanned(dirPath: string, mtimeMs: number, fileCount: number) {
      pendingDirCache.push({ dirPath, mtimeMs, fileCount });
    },
  };
  const freshSource = new LocalPhotoSource(paths, config.sources.local.extensions, {
    ...sourceOptions,
    directoryChecker: scanChecker,
  });

  // Verbose output helper
  const verboseLog: VerboseInfo[] = [];
  const onVerbose = options.verbose
    ? (info: VerboseInfo) => {
        verboseLog.push(info);
      }
    : undefined;

  const { personPhotos, stats } = await scanner.scanPhotosParallel(
    freshSource.scan(),
    totalPhotos,
    scanId,
    (progress) => {
      const newScans = progress.processed - progress.cached;
      const progressValue = useNewScansProgress ? newScans : progress.processed;
      progressBar.update(progressValue, {
        matched: useNewScansProgress ? progress.newMatched : progress.matched,
        cached: progress.cached,
        file: basename(progress.currentPhoto),
      });
    },
    options.rescan ?? false,
    options.limit,  // Limit applies to new (non-cached) scans only
    onVerbose,
    config.scanning.concurrency
  );

  progressBar.stop();

  // Show verbose output
  if (options.verbose && verboseLog.length > 0) {
    console.log("\nScanned files:");
    for (const info of verboseLog) {
      const status = info.fromCache ? "[CACHED]" : "[NEW]   ";
      const matches = info.matches.length > 0
        ? info.matches.map(m => `${m.personName} (${m.confidence.toFixed(0)}%)`).join(", ")
        : "no match";
      console.log(`  ${status} ${info.path} - ${matches}`);
    }
  }

  // Complete scan record
  const durationMs = completeScan(scanId, stats);

  // Persist directory cache now that scan completed successfully
  for (const entry of pendingDirCache) {
    saveDirectoryCache(entry.dirPath, entry.mtimeMs, entry.fileCount, scanId);
  }

  // Update person photo counts
  updateAllPersonPhotoCounts();

  // Show duration and cache stats
  const avgPerPhoto = stats.photosProcessed > 0 ? durationMs / stats.photosProcessed : 0;
  console.log(`\nCompleted in ${formatDuration(durationMs)} (${stats.photosProcessed} photos @ ${Math.round(avgPerPhoto)}ms/photo avg)`);
  console.log(`Cache: ${stats.photosCached} cached, ${stats.photosProcessed - stats.photosCached} new`);

  // Filter to only NEW photos (not from cache) for summary and album creation
  const newPersonPhotos = new Map<string, PhotoMatch[]>();
  for (const [person, matches] of personPhotos) {
    const newPhotos = matches.filter(m => !m.fromCache);
    if (newPhotos.length > 0) {
      newPersonPhotos.set(person, newPhotos);
    }
  }

  // Summary of new matches only
  if (newPersonPhotos.size === 0) {
    if (stats.photosCached > 0) {
      console.log("\nNo new faces matched (all photos were cached).");
    } else {
      console.log("\nNo faces matched. Try:");
      console.log("  - Adding more reference photos");
      console.log("  - Lowering minConfidence in config.yaml");
    }
    if (options.report) {
      console.log("\n--- Scan Report ---");
      await photosListCommand({ scan: scanId, status: "all", person: options.person, limit: config.display.photoLimit });
    }
    return;
  }

  console.log("\nNew matches found:");
  for (const [person, matches] of newPersonPhotos) {
    const avgConfidence = calculateAvgConfidence(matches);
    console.log(`  ${person}: ${matches.length} photos (avg ${avgConfidence.toFixed(1)}% confidence)`);
  }

  // Build flat list of all matches for table display
  const TABLE_LIMIT = config.display.photoLimit;
  const allMatches: PhotoRow[] = [];
  let idx = 0;
  for (const [person, matches] of newPersonPhotos) {
    for (const match of matches) {
      idx++;
      const bestMatch = match.matches.reduce((best, m) =>
        m.confidence > best.confidence ? m : best
      );
      // Extract date from filename
      const photoDate = extractDateFromFilename(basename(match.photoPath)) ?? undefined;
      allMatches.push({
        index: idx,
        person,
        confidence: bestMatch.confidence,
        status: "pending",
        path: match.photoPath,
        date: photoDate,
      });
    }
  }

  // Display table of found photos (limit to 50)
  const displayMatches = allMatches.slice(0, TABLE_LIMIT);

  console.log("\nFound Photos:");
  printPhotoTable(displayMatches, config.display.columns);

  if (allMatches.length > TABLE_LIMIT) {
    console.log(`\nShowing ${TABLE_LIMIT} of ${allMatches.length} photos.`);
    console.log(`Use 'claude-book photos --scan ${scanId}' for full list.`);
  }

  console.log("\nNext steps:");
  console.log(`  claude-book photos --scan ${scanId}           Review photos from this scan`);
  console.log("  claude-book photos approve <indexes>      Approve correct matches");
  console.log("  claude-book photos reject <indexes>       Reject false positives");
  console.log("  claude-book photos export                 Create albums for approved photos");

  if (options.report) {
    console.log("\n--- Scan Report ---");
    await photosListCommand({ scan: scanId, status: "all", person: options.person, limit: config.display.photoLimit });
  }
}

/**
 * Open photos in macOS Preview
 */
function openPhotosInPreview(paths: string[]): void {
  if (paths.length === 0) return;
  spawn("open", paths, { detached: true, stdio: "ignore" });
}

interface ScanListHistoryOptions {
  limit?: number;
  open?: boolean;
  json?: boolean;
}

/**
 * scan list - Show scan history
 */
export async function scanListHistoryCommand(options: ScanListHistoryOptions = {}): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Run 'claude-book scan' first.");
    return;
  }

  const limit = options.limit ?? 10;
  const scans = getRecentScans(limit);

  if (scans.length === 0) {
    console.log("No scans found. Run 'claude-book scan <path>' first.");
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(scans, null, 2));
    return;
  }

  // Table header
  console.log("ID   Date                 Photos   Matches  New    Duration   Source");
  console.log("─".repeat(90));

  for (const scan of scans) {
    const date = new Date(scan.startedAt);
    const dateStr = date.toLocaleString();
    const newScans = scan.photosProcessed - scan.photosCached;
    const durationStr = scan.durationMs ? formatDuration(scan.durationMs) : "-";
    const source = scan.sourcePaths.length > 0
      ? scan.sourcePaths[0].replace(homedir(), "~")
      : "(unknown)";
    const truncatedSource = source.length > 25 ? source.slice(0, 22) + "..." : source;

    console.log(
      `${String(scan.id).padEnd(5)}${dateStr.padEnd(21)}${String(scan.photosProcessed).padEnd(9)}${String(scan.matchesFound).padEnd(9)}${String(newScans).padEnd(7)}${durationStr.padEnd(11)}${truncatedSource}`
    );
  }

  // Open photos from latest scan if requested
  if (options.open && scans.length > 0) {
    const latestScan = scans[0];
    const photos = getPhotosByScan(latestScan.id);
    const photosWithMatches = photos.filter(p => p.recognitions.length > 0);

    if (photosWithMatches.length > 0) {
      const paths = photosWithMatches.map(p => p.path);
      openPhotosInPreview(paths);
      console.log(`\nOpened ${paths.length} photos from scan #${latestScan.id} in Preview.`);
    }
  }

  console.log();
  console.log("Use 'claude-book scan show <id>' to view scan details.");
  console.log("Use 'claude-book photos --scan <id>' to manage photos from a scan.");
}

interface ScanShowOptions {
  open?: boolean;
  json?: boolean;
}

/**
 * scan show <id> - Show details for a specific scan
 */
export async function scanShowCommand(scanId: string, options: ScanShowOptions = {}): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Run 'claude-book scan' first.");
    return;
  }

  const parsedId = parseInt(scanId, 10);
  if (isNaN(parsedId)) {
    console.error(`Invalid scan ID: ${scanId}`);
    process.exit(1);
  }

  const scan = getScanById(parsedId);
  if (!scan) {
    console.log(`Scan #${scanId} not found.`);
    return;
  }

  const photos = getPhotosByScan(scan.id);
  const photosWithMatches = photos.filter(p => p.recognitions.length > 0);

  if (options.json) {
    console.log(JSON.stringify({
      scan,
      photos: photosWithMatches.map((p, idx) => ({
        index: idx + 1,
        path: p.path,
        hash: p.hash,
        recognitions: p.recognitions,
        corrections: p.corrections,
      })),
    }, null, 2));
    return;
  }

  // Print scan info header
  const date = new Date(scan.startedAt);
  console.log(`Scan #${scan.id} (${date.toLocaleString()})`);
  if (scan.sourcePaths.length > 0) {
    console.log(`Path: ${scan.sourcePaths.join(", ")}`);
  }
  console.log(`Photos: ${scan.photosProcessed} processed, ${scan.matchesFound} with matches`);
  if (scan.durationMs) {
    const avgPerPhoto = scan.photosProcessed > 0 ? scan.durationMs / scan.photosProcessed : 0;
    console.log(`Duration: ${formatDuration(scan.durationMs)} (${Math.round(avgPerPhoto)}ms/photo avg)`);
  }
  console.log();

  if (photosWithMatches.length === 0) {
    console.log("No matches found in this scan.");
    return;
  }

  console.log(`Photos with matches (${photosWithMatches.length}):`);
  console.log();

  // Print each photo with index
  photosWithMatches.forEach((photo, idx) => {
    const matches = photo.recognitions
      .map((r) => `${r.personName} (${Math.round(r.confidence)}%)`)
      .join(", ");
    console.log(`[${idx + 1}] ${photo.path}`);
    console.log(`     ${matches}`);
  });

  // Open photos in Preview if requested
  if (options.open && photosWithMatches.length > 0) {
    const paths = photosWithMatches.map(p => p.path);
    openPhotosInPreview(paths);
    console.log(`\nOpened ${paths.length} photos in Preview.`);
  }

  console.log();
  console.log("Use 'claude-book photos --scan " + scan.id + "' to manage these photos.");
}

interface ScanClearOptions {
  yes?: boolean;
}

/**
 * scan clear - Clear all scans and reset photo recognitions
 */
export async function scanClearCommand(options: ScanClearOptions = {}): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Nothing to clear.");
    return;
  }

  const scans = getRecentScans(1);
  if (scans.length === 0) {
    console.log("No scans found. Nothing to clear.");
    return;
  }

  console.log("This will clear all scans and reset photo recognitions.");
  console.log("Photo records will be preserved, but their recognitions and corrections will be cleared.");
  console.log();

  if (!options.yes) {
    const confirmed = await confirm("Are you sure?");
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = clearAllScans();
  console.log(`Cleared ${result.scansCleared} scan(s) and reset ${result.photosReset} photo(s).`);
}

/**
 * scan uncache - Remove a directory from the cache so it gets re-scanned
 */
export function scanUncacheCommand(dirPath: string): void {
  initDatabase();
  const resolved = expandPath(dirPath);
  const removed = removeDirectoryCache(resolved);
  if (removed > 0) {
    console.log(`Removed ${removed} director${removed === 1 ? "y" : "ies"} from cache.`);
  } else {
    console.log(`No cached entries found for: ${resolved}`);
  }
}
