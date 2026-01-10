import ora from "ora";
import { loadConfig, getConfigPath } from "../config";
import { FaceRecognitionClient } from "../rekognition/client";
import { existsSync } from "fs";

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
    const client = new FaceRecognitionClient(
      config.aws.region,
      config.rekognition.collectionId,
      config.rekognition.minConfidence
    );

    const info = await client.getCollectionInfo();

    if (info) {
      spinner.stop();
      console.log(`  ✓ Collection: ${info.collectionId}`);
      console.log(`  ✓ Total faces indexed: ${info.faceCount}`);
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

  // Show config summary
  console.log("\nSettings:");
  console.log(`  AWS Region: ${config.aws.region}`);
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
