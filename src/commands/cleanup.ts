import ora from "ora";
import { createInterface } from "readline";
import { loadConfig } from "../config";
import { FaceRecognitionClient } from "../rekognition/client";

interface CleanupOptions {
  force?: boolean;
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

export async function cleanupCommand(options: CleanupOptions): Promise<void> {
  const config = loadConfig();
  const spinner = ora();

  console.log("This will delete the AWS Rekognition collection:");
  console.log(`  Collection: ${config.rekognition.collectionId}`);
  console.log("\nAll indexed faces will be permanently deleted.");

  if (!options.force) {
    const confirmed = await confirm("\nAre you sure you want to continue?");
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  spinner.start("Deleting collection...");

  try {
    const client = new FaceRecognitionClient(
      config.aws.region,
      config.rekognition.collectionId,
      config.rekognition.minConfidence
    );

    await client.deleteCollection();
    spinner.succeed("Collection deleted successfully");

    console.log("\nTo start fresh, run:");
    console.log("  claude-book init");
    console.log("  claude-book train -r ./references");
  } catch (error: any) {
    spinner.fail(`Failed to delete collection: ${error.message}`);
    process.exit(1);
  }
}
