import ora from "ora";
import { loadConfig, getConfigPath } from "../config";
import { FaceRecognitionClient } from "../rekognition/client";
import { existsSync } from "fs";
import {
  initDatabase,
  getStats,
  getAllPersons,
  getRecentScans,
  getDirectoryCacheStats,
} from "../db";

export async function statusCommand(): Promise<void> {
  const spinner = ora();
  const configPath = getConfigPath();

  // Check config
  console.log("Configuration:");
  if (existsSync(configPath)) {
    console.log(`  ✓ Config file: ${configPath}`);
  } else {
    console.log(`  ✗ Config file not found (run 'claude-book init')`);
    return;
  }

  const config = loadConfig();

  // Check references directory
  console.log(`\n  References path: ${config.training.referencesPath}`);
  if (existsSync(config.training.referencesPath)) {
    console.log(`  ✓ References directory exists`);
  } else {
    console.log(`  ✗ References directory not found`);
  }

  // Check AWS collection
  console.log("\nAWS Rekognition:");
  spinner.start("Checking collection...");

  try {
    const client = new FaceRecognitionClient(config);

    const info = await client.getCollectionInfo();

    if (info) {
      spinner.stop();
      console.log(`  ✓ Collection: ${info.collectionId}`);
      console.log(`  ✓ Total faces indexed: ${info.faceCount}`);
      if (info.userCount > 0) {
        console.log(`  ✓ Users (aggregated vectors): ${info.userCount}`);
      }
      if (info.createdAt) {
        console.log(`  ✓ Created: ${info.createdAt.toLocaleString()}`);
      }

      // Get face counts per person
      if (info.faceCount > 0) {
        spinner.start("Loading face details...");
        const personCounts = await client.listFaces();
        spinner.stop();

        console.log("\n  Indexed people:");
        for (const [person, count] of personCounts) {
          console.log(`    - ${person}: ${count} face(s)`);
        }
      }
    } else {
      spinner.stop();
      console.log(`  ✗ Collection not found (run 'claude-book init')`);
    }
  } catch (error: any) {
    spinner.fail(`Failed to check collection: ${error.message}`);
  }

  // Show database stats
  console.log("\nLocal Database:");
  try {
    initDatabase();
    const stats = getStats();
    const persons = getAllPersons();
    const recentScans = getRecentScans(5);

    console.log(`  ✓ Total photos scanned: ${stats.totalPhotos}`);
    console.log(`  ✓ Photos with matches: ${stats.photosWithMatches}`);

    if (stats.totalCorrections > 0) {
      console.log(`  ✓ Corrections recorded: ${stats.totalCorrections}`);
      console.log(`      Approved: ${stats.approvedCount}`);
      console.log(`      Rejected (false positives): ${stats.rejectedCount}`);
      console.log(`      Added (false negatives): ${stats.falseNegativeCount}`);
    } else {
      console.log(`  ○ No corrections recorded yet`);
    }

    if (persons.length > 0) {
      console.log("\n  People in database:");
      for (const person of persons) {
        const displayName = person.displayName ? ` (${person.displayName})` : "";
        console.log(`    - ${person.name}${displayName}: ${person.faceCount} faces, ${person.photoCount} matched photos`);
      }
    }

    if (stats.lastScan) {
      console.log("\n  Last scan:");
      const date = new Date(stats.lastScan.startedAt);
      console.log(`    Date: ${date.toLocaleString()}`);
      console.log(`    Photos: ${stats.lastScan.photosProcessed} processed, ${stats.lastScan.photosCached} from cache`);
      console.log(`    Matches: ${stats.lastScan.matchesFound}`);
    }

    if (recentScans.length > 1) {
      console.log("\n  Recent scans:");
      for (const scan of recentScans.slice(0, 5)) {
        const date = new Date(scan.startedAt);
        const dateStr = date.toLocaleDateString();
        const cacheHitRate = scan.photosProcessed > 0
          ? ((scan.photosCached / scan.photosProcessed) * 100).toFixed(0)
          : 0;
        console.log(`    ${dateStr}: ${scan.photosProcessed} photos, ${scan.matchesFound} matches (${cacheHitRate}% cache)`);
      }
    }

    const dirCache = getDirectoryCacheStats();
    if (dirCache.directories > 0) {
      console.log(`\n  Directory cache:`);
      console.log(`    Cached directories: ${dirCache.directories}`);
      console.log(`    Cached files: ${dirCache.files.toLocaleString()}`);
    }
  } catch {
    console.log(`  ○ Database not initialized (run 'claude-book scan' first)`);
  }

  // Show config summary
  console.log("\nSettings:");
  console.log(`  AWS Region: ${config.aws.region}`);
  console.log(`  Search method: ${config.rekognition.searchMethod}`);
  console.log(`  Min confidence: ${config.rekognition.minConfidence}%`);
  console.log(`  Album prefix: "${config.albums.prefix}"`);

  if (config.sources.local.paths.length > 0) {
    console.log("\n  Source paths:");
    for (const p of config.sources.local.paths) {
      const exists = existsSync(p);
      console.log(`    ${exists ? "✓" : "✗"} ${p}`);
    }
  }
}
