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
import { resolve, basename } from "path";
import { homedir } from "os";
import {
  initDatabase,
  createScan,
  completeScan,
  updateAllPersonPhotoCounts,
} from "../db";

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
