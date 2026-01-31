import ora from "ora";
import { loadConfig } from "../config";
import { FaceRecognitionClient } from "../rekognition/client";
import { confirm } from "../utils/confirm";

interface CleanupOptions {
  yes?: boolean;
}

export async function cleanupCommand(options: CleanupOptions): Promise<void> {
  const config = loadConfig();
  const spinner = ora();

  console.log("This will delete the AWS Rekognition collection:");
  console.log(`  Collection: ${config.rekognition.collectionId}`);
  console.log("\nAll indexed faces will be permanently deleted.");

  if (!options.yes) {
    const confirmed = await confirm("\nAre you sure you want to continue?");
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  spinner.start("Deleting collection...");

  try {
    const client = new FaceRecognitionClient(config);

    await client.deleteCollection();
    spinner.succeed("Collection deleted successfully");

    console.log("\nTo start fresh, run:");
    console.log("  openbook init");
    console.log("  openbook train -r ./references");
  } catch (error: any) {
    spinner.fail(`Failed to delete collection: ${error.message}`);
    process.exit(1);
  }
}
