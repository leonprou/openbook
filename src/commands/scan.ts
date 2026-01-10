import ora from "ora";
import cliProgress from "cli-progress";
import { loadConfig } from "../config";
import { FaceRecognitionClient } from "../rekognition/client";
import { LocalPhotoSource } from "../sources/local";
import { PhotoScanner } from "../pipeline/scanner";
import {
  checkOsxphotosInstalled,
  createAlbumsForPeople,
} from "../export/albums";
import { existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

interface ScanOptions {
  source?: string;
  path?: string;
  dryRun?: boolean;
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

export async function scanCommand(options: ScanOptions): Promise<void> {
  const config = loadConfig();
  const spinner = ora();

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

  // Count photos
  spinner.start("Counting photos...");
  const source = new LocalPhotoSource(paths, config.sources.local.extensions);
  const totalPhotos = await source.count();

  if (totalPhotos === 0) {
    spinner.fail("No photos found in the specified paths");
    process.exit(1);
  }
  spinner.succeed(`Found ${totalPhotos} photos to scan`);

  // Scan photos
  const progressBar = new cliProgress.SingleBar(
    {
      format: "Scanning |{bar}| {percentage}% | {value}/{total} | Matched: {matched}",
    },
    cliProgress.Presets.shades_classic
  );

  progressBar.start(totalPhotos, 0, { matched: 0 });

  const scanner = new PhotoScanner(client, config.rekognition.minConfidence);
  const freshSource = new LocalPhotoSource(paths, config.sources.local.extensions);

  const personPhotos = await scanner.scanPhotos(
    freshSource.scan(),
    totalPhotos,
    (progress) => {
      progressBar.update(progress.processed, { matched: progress.matched });
    }
  );

  progressBar.stop();

  // Summary of found matches
  if (personPhotos.size === 0) {
    console.log("\nNo faces matched. Try:");
    console.log("  - Adding more reference photos");
    console.log("  - Lowering minConfidence in config.yaml");
    return;
  }

  console.log("\nMatches found:");
  for (const [person, photos] of personPhotos) {
    console.log(`  ${person}: ${photos.length} photos`);
  }

  // Create albums
  if (options.dryRun) {
    console.log("\n[Dry run] Would create albums:");
    for (const [person, photos] of personPhotos) {
      console.log(`  "${config.albums.prefix}: ${person}" (${photos.length} photos)`);
    }
    return;
  }

  spinner.start("Creating Apple Photos albums...");
  const albumResults = await createAlbumsForPeople(
    personPhotos,
    config.albums.prefix,
    false
  );
  spinner.stop();

  console.log("\nAlbum results:");
  for (const result of albumResults) {
    if (result.errors.length === 0) {
      console.log(`  ✓ "${result.albumName}": ${result.photosAdded} photos added`);
    } else {
      console.log(`  ✗ "${result.albumName}": ${result.errors.join(", ")}`);
    }
  }

  const totalAdded = albumResults.reduce((sum, r) => sum + r.photosAdded, 0);
  console.log(`\nDone! Added ${totalAdded} photos to ${albumResults.length} albums.`);
}
