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

  let foundMessage = `Found ${totalPhotos} photos to scan`;
  if (options.limit || options.filter) {
    const parts: string[] = [];
    if (options.filter) parts.push(`filter: ${options.filter}`);
    if (options.limit) parts.push(`limit: ${options.limit} new scans`);
    foundMessage += ` (${parts.join(", ")})`;
  }
  spinner.succeed(foundMessage);

  // Create scan record
  const scanId = createScan(paths);

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
        matched: progress.matched,
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

  // Summary of found matches
  if (personPhotos.size === 0) {
    console.log("\nNo faces matched. Try:");
    console.log("  - Adding more reference photos");
    console.log("  - Lowering minConfidence in config.yaml");
    return;
  }

  console.log("\nMatches found:");
  for (const [person, matches] of personPhotos) {
    const avgConfidence = calculateAvgConfidence(matches);
    console.log(`  ${person}: ${matches.length} photos (avg ${avgConfidence.toFixed(1)}% confidence)`);
  }

  // Show cache stats
  console.log(`\nCache stats: ${stats.photosCached} from cache, ${stats.photosProcessed - stats.photosCached} newly scanned`);

  // Convert PhotoMatch[] to string[] for album creation
  const personPhotoPaths = new Map<string, string[]>();
  for (const [person, matches] of personPhotos) {
    personPhotoPaths.set(person, matches.map(m => m.photoPath));
  }

  // Create review albums
  if (options.dryRun) {
    console.log("\n[Dry run] Would create review albums:");
    for (const [person, matches] of personPhotos) {
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
 * Photo with index for list/approve commands
 */
export interface IndexedPhoto extends Photo {
  index: number;
}

/**
 * Get scan and its photos with indexes
 */
function getScanWithPhotos(scanId?: number): { scan: Scan; photos: IndexedPhoto[] } | null {
  const scan = scanId ? getScanById(scanId) : getLastScan();
  if (!scan) return null;

  const photos = getPhotosByScan(scan.id);
  const indexedPhotos: IndexedPhoto[] = photos.map((photo, idx) => ({
    ...photo,
    index: idx + 1, // 1-based indexing
  }));

  return { scan, photos: indexedPhotos };
}

interface ScanListOptions {
  all?: boolean;
  open?: boolean;
}

/**
 * Open photos in macOS Preview
 */
function openPhotosInPreview(paths: string[]): void {
  if (paths.length === 0) return;
  spawn("open", paths, { detached: true, stdio: "ignore" });
}

/**
 * scan list - Show details about a scan
 */
export async function scanListCommand(scanId?: string, options: ScanListOptions = {}): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Run 'claude-book scan run' first.");
    return;
  }

  const parsedId = scanId ? parseInt(scanId, 10) : undefined;
  if (scanId && isNaN(parsedId!)) {
    console.error(`Invalid scan ID: ${scanId}`);
    process.exit(1);
  }

  const result = getScanWithPhotos(parsedId);
  if (!result) {
    if (scanId) {
      console.log(`Scan #${scanId} not found.`);
    } else {
      console.log("No scans found. Run 'claude-book scan run' first.");
    }
    return;
  }

  const { scan, photos } = result;

  // Print scan info header
  const date = new Date(scan.startedAt);
  console.log(`Scan #${scan.id} (${date.toLocaleDateString()})`);
  if (scan.sourcePaths.length > 0) {
    console.log(`Path: ${scan.sourcePaths.join(", ")}`);
  }
  console.log(`Photos: ${scan.photosProcessed} processed, ${scan.matchesFound} with matches`);
  console.log();

  if (photos.length === 0) {
    console.log("No photos found in this scan.");
    return;
  }

  // Show all photos or only those with matches
  const photosToShow = options.all ? photos : photos.filter(p => p.recognitions.length > 0);

  if (photosToShow.length === 0) {
    console.log("No matches found in this scan.");
    console.log(`(${photos.length} photos scanned with no face matches)`);
    console.log("\nUse --all to show all photos.");
    return;
  }

  const label = options.all ? "All photos" : "Photos with matches";
  console.log(`${label} (${photosToShow.length}):`);
  console.log();

  // Print each photo
  for (const photo of photosToShow) {
    if (photo.recognitions.length > 0) {
      const matches = photo.recognitions
        .map((r) => `${r.personName} (${Math.round(r.confidence)}%)`)
        .join(", ");
      console.log(`[${photo.index}] ${photo.path}`);
      console.log(`     ${matches}`);
    } else {
      console.log(`[${photo.index}] ${photo.path}`);
      console.log(`     (no matches)`);
    }
  }

  // Open photos in Preview if requested
  if (options.open && photosToShow.length > 0) {
    const paths = photosToShow.map(p => p.path);
    openPhotosInPreview(paths);
    console.log(`\nOpened ${paths.length} photos in Preview.`);
  }

  console.log();
  console.log("To approve photos: claude-book scan approve [scanId] --reject <indexes>");
  console.log("To approve specific: claude-book scan approve --photos <indexes>");
}

interface ScanApproveOptions {
  reject?: string;  // comma-separated indexes to reject
  photos?: string;  // comma-separated indexes to approve
}

/**
 * Parse comma-separated indexes string into number array
 */
function parseIndexes(str: string): number[] {
  return str
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

/**
 * scan approve - Approve/reject photos from a scan
 */
export async function scanApproveCommand(
  scanId: string | undefined,
  options: ScanApproveOptions
): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Run 'claude-book scan run' first.");
    return;
  }

  const parsedScanId = scanId ? parseInt(scanId, 10) : undefined;
  if (scanId && isNaN(parsedScanId!)) {
    console.error(`Invalid scan ID: ${scanId}`);
    process.exit(1);
  }

  const result = getScanWithPhotos(parsedScanId);
  if (!result) {
    if (scanId) {
      console.log(`Scan #${scanId} not found.`);
    } else {
      console.log("No scans found. Run 'claude-book scan run' first.");
    }
    return;
  }

  const { scan, photos } = result;

  // Filter to photos with matches
  const photosWithMatches = photos.filter(p => p.recognitions.length > 0);

  if (photosWithMatches.length === 0) {
    console.log("No photos with matches in this scan.");
    return;
  }

  // Determine which photos to approve/reject
  let toApprove: IndexedPhoto[];
  let toReject: IndexedPhoto[];

  if (options.photos) {
    // Approve only specific indexes
    const approveIndexes = new Set(parseIndexes(options.photos));
    toApprove = photosWithMatches.filter((p) => approveIndexes.has(p.index));
    toReject = [];
  } else if (options.reject) {
    // Approve all except specified indexes
    const rejectIndexes = new Set(parseIndexes(options.reject));
    toApprove = photosWithMatches.filter((p) => !rejectIndexes.has(p.index));
    toReject = photosWithMatches.filter((p) => rejectIndexes.has(p.index));
  } else {
    // Approve all photos
    toApprove = photosWithMatches;
    toReject = [];
  }

  if (toApprove.length === 0 && toReject.length === 0) {
    console.log("No photos to process. Check your indexes.");
    return;
  }

  console.log(`Scan #${scan.id}:`);
  console.log(`  Approving: ${toApprove.length} photos`);
  if (toReject.length > 0) {
    console.log(`  Rejecting: ${toReject.length} photos`);
  }
  console.log();

  // Apply corrections
  let approvedCount = 0;
  let rejectedCount = 0;

  for (const photo of toApprove) {
    for (const recognition of photo.recognitions) {
      const success = addCorrection(
        photo.hash,
        recognition.personId,
        recognition.personName,
        "approved"
      );
      if (success) approvedCount++;
    }
  }

  for (const photo of toReject) {
    for (const recognition of photo.recognitions) {
      const success = addCorrection(
        photo.hash,
        recognition.personId,
        recognition.personName,
        "false_positive"
      );
      if (success) rejectedCount++;
    }
  }

  console.log(`Corrections recorded:`);
  console.log(`  ${approvedCount} approved`);
  if (rejectedCount > 0) {
    console.log(`  ${rejectedCount} rejected`);
  }

  // Create albums for approved photos
  if (toApprove.length > 0) {
    const config = loadConfigForApprove();
    const personPhotos = new Map<string, string[]>();

    for (const photo of toApprove) {
      for (const recognition of photo.recognitions) {
        const existing = personPhotos.get(recognition.personName) ?? [];
        existing.push(photo.path);
        personPhotos.set(recognition.personName, existing);
      }
    }

    console.log();
    console.log("Creating albums...");

    for (const [personName, photoPaths] of personPhotos) {
      const albumName = `${config.albums.prefix}: ${personName}`;
      const result = await addPhotosToAlbum(albumName, photoPaths);

      if (result.errors.length === 0) {
        console.log(`  ✓ "${albumName}": ${result.photosAdded} photos`);
      } else {
        console.log(`  ✗ "${albumName}": ${result.errors.join(", ")}`);
      }
    }
  }

  console.log();
  console.log("Done!");
}
