import ora from "ora";
import cliProgress from "cli-progress";
import { loadConfig } from "../config";
import { FaceRecognitionClient } from "../rekognition/client";
import { LocalPhotoSource } from "../sources/local";
import { PhotoScanner, type PhotoMatch, type VerboseInfo } from "../pipeline/scanner";
import {
  checkOsxphotosInstalled,
  createAlbumsForPeople,
} from "../export/albums";
import { existsSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { resolve, basename } from "path";
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
  type Photo,
  type Scan,
} from "../db";
import { loadConfig as loadConfigForApprove } from "../config";
import { addPhotosToAlbum } from "../export/albums";

const REVIEW_STATE_FILE = ".claude-book-review.json";
const REVIEW_SUFFIX = "(Review)";

export interface ReviewState {
  createdAt: string;
  albumPrefix: string;
  scanId: number;
  people: Record<string, {
    reviewAlbum: string;
    photoCount: number;
    avgConfidence: number;
  }>;
}

interface ScanOptions {
  source?: string;
  path?: string;
  dryRun?: boolean;
  rescan?: boolean;
  limit?: number;
  filter?: string;
  verbose?: boolean;
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
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

  // Check osxphotos is installed (unless dry run)
  if (!options.dryRun) {
    spinner.start("Checking osxphotos installation...");
    const osxphotosInstalled = await checkOsxphotosInstalled();
    if (!osxphotosInstalled) {
      spinner.fail("osxphotos is not installed");
      console.error("\nInstall osxphotos to create Apple Photos albums:");
      console.error("  uv tool install osxphotos");
      console.error("  # or: pip install osxphotos");
      console.error("\nOr use --dry-run to see what would be organized.");
      process.exit(1);
    }
    spinner.succeed("osxphotos is installed");
  }

  // Check collection exists
  spinner.start("Checking face collection...");
  const client = new FaceRecognitionClient(
    config.aws.region,
    config.rekognition.collectionId,
    config.rekognition.minConfidence
  );

  const collectionInfo = await client.getCollectionInfo();
  if (!collectionInfo || collectionInfo.faceCount === 0) {
    spinner.fail("No faces indexed. Run 'claude-book train' first.");
    process.exit(1);
  }
  spinner.succeed(`Collection has ${collectionInfo.faceCount} indexed faces`);

  // Build source options (limit is handled by scanner for new scans only)
  const sourceOptions = {
    filter: options.filter ? new RegExp(options.filter) : undefined,
  };

  // Count photos
  spinner.start("Counting photos...");
  const source = new LocalPhotoSource(paths, config.sources.local.extensions, sourceOptions);
  const totalPhotos = await source.count();

  if (totalPhotos === 0) {
    spinner.fail("No photos found in the specified paths");
    if (options.filter) {
      console.error(`  Filter applied: ${options.filter}`);
    }
    process.exit(1);
  }

  // Create scan record first so we can show the ID
  const scanId = createScan(paths);

  let foundMessage = `[Scan #${scanId}] Found ${totalPhotos} photos`;
  if (options.limit || options.filter) {
    const parts: string[] = [];
    if (options.filter) parts.push(`filter: ${options.filter}`);
    if (options.limit) parts.push(`limit: ${options.limit} new`);
    foundMessage += ` (${parts.join(", ")})`;
  }
  spinner.succeed(foundMessage);

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
      barsize: 20,
    },
    cliProgress.Presets.shades_classic
  );

  progressBar.start(progressTotal, 0, { matched: 0, cached: 0, file: "" });

  const scanner = new PhotoScanner(client, config.rekognition.minConfidence);
  const freshSource = new LocalPhotoSource(paths, config.sources.local.extensions, sourceOptions);

  // Verbose output helper
  const verboseLog: VerboseInfo[] = [];
  const onVerbose = options.verbose
    ? (info: VerboseInfo) => {
        verboseLog.push(info);
      }
    : undefined;

  const { personPhotos, stats } = await scanner.scanPhotosWithCache(
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
    onVerbose
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
  completeScan(scanId, stats);

  // Update person photo counts
  updateAllPersonPhotoCounts();

  // Show cache stats
  console.log(`\nCache: ${stats.photosCached} cached, ${stats.photosProcessed - stats.photosCached} new`);

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
    return;
  }

  console.log("\nNew matches found:");
  for (const [person, matches] of newPersonPhotos) {
    const avgConfidence = calculateAvgConfidence(matches);
    console.log(`  ${person}: ${matches.length} photos (avg ${avgConfidence.toFixed(1)}% confidence)`);
  }

  // Convert to paths for album creation
  const personPhotoPaths = new Map<string, string[]>();
  for (const [person, matches] of newPersonPhotos) {
    personPhotoPaths.set(person, matches.map(m => m.photoPath));
  }

  // Create review albums
  if (options.dryRun) {
    console.log("\n[Dry run] Would create review albums:");
    for (const [person, matches] of newPersonPhotos) {
      const avgConfidence = calculateAvgConfidence(matches);
      console.log(`  "${config.albums.prefix}: ${person} ${REVIEW_SUFFIX}" (${matches.length} photos, avg ${avgConfidence.toFixed(1)}%)`);
    }
    return;
  }

  spinner.start("Creating review albums in Apple Photos...");
  const albumResults = await createAlbumsForPeople(
    personPhotoPaths,
    config.albums.prefix,
    false,
    REVIEW_SUFFIX
  );
  spinner.stop();

  console.log("\nReview albums created:");
  for (const result of albumResults) {
    if (result.errors.length === 0) {
      console.log(`  ✓ "${result.albumName}": ${result.photosAdded} photos`);
    } else {
      console.log(`  ✗ "${result.albumName}": ${result.errors.join(", ")}`);
    }
  }

  // Save review state
  const reviewState: ReviewState = {
    createdAt: new Date().toISOString(),
    albumPrefix: config.albums.prefix,
    scanId,
    people: {},
  };

  for (const [person, matches] of personPhotos) {
    reviewState.people[person] = {
      reviewAlbum: `${config.albums.prefix}: ${person} ${REVIEW_SUFFIX}`,
      photoCount: matches.length,
      avgConfidence: calculateAvgConfidence(matches),
    };
  }

  writeFileSync(REVIEW_STATE_FILE, JSON.stringify(reviewState, null, 2));

  const totalAdded = albumResults.reduce((sum, r) => sum + r.photosAdded, 0);
  console.log(`\nAdded ${totalAdded} photos to ${albumResults.length} review albums.`);
  console.log("\nNext steps:");
  console.log("  1. Open Apple Photos and review the albums");
  console.log("  2. Remove any incorrect photos from the review albums");
  console.log("  3. Run 'claude-book approve' to approve correct matches");
  console.log("  4. Run 'claude-book reject' to mark false positives");
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
  all?: boolean;
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

  // Filter out scans with no matches unless --all
  const scansToShow = options.all ? scans : scans.filter(s => s.matchesFound > 0);

  if (scansToShow.length === 0) {
    console.log("No scans with matches found.");
    console.log("Use --all to show all scans.");
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(scansToShow, null, 2));
    return;
  }

  // Table header
  console.log("ID   Date                 Photos   Matches  New    Source");
  console.log("─".repeat(75));

  for (const scan of scansToShow) {
    const date = new Date(scan.startedAt);
    const dateStr = date.toLocaleString();
    const newScans = scan.photosProcessed - scan.photosCached;
    const source = scan.sourcePaths.length > 0
      ? scan.sourcePaths[0].replace(homedir(), "~")
      : "(unknown)";
    const truncatedSource = source.length > 30 ? source.slice(0, 27) + "..." : source;

    console.log(
      `${String(scan.id).padEnd(5)}${dateStr.padEnd(21)}${String(scan.photosProcessed).padEnd(9)}${String(scan.matchesFound).padEnd(9)}${String(newScans).padEnd(7)}${truncatedSource}`
    );
  }

  // Open photos from latest scan if requested
  if (options.open && scansToShow.length > 0) {
    const latestScan = scansToShow[0];
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
