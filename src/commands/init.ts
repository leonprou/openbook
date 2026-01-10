import { writeFileSync, existsSync, mkdirSync } from "fs";
import ora from "ora";
import { loadConfig, getConfigPath, getDefaultConfig } from "../config";
import { FaceRecognitionClient } from "../rekognition/client";

export async function initCommand(): Promise<void> {
  const spinner = ora();

  // Create config file if it doesn't exist
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    spinner.start("Creating config file...");
    writeFileSync(configPath, getDefaultConfig());
    spinner.succeed(`Created config file: ${configPath}`);
  } else {
    spinner.info(`Config file already exists: ${configPath}`);
  }

  const config = loadConfig();

  // Create references directory if it doesn't exist
  if (!existsSync(config.training.referencesPath)) {
    mkdirSync(config.training.referencesPath, { recursive: true });
    spinner.succeed(
      `Created references directory: ${config.training.referencesPath}`
    );
  }

  // Create AWS Rekognition collection
  spinner.start("Creating AWS Rekognition collection...");
  try {
    const client = new FaceRecognitionClient(
      config.aws.region,
      config.rekognition.collectionId,
      config.rekognition.minConfidence
    );
    await client.createCollection();
    spinner.succeed(
      `AWS Rekognition collection ready: ${config.rekognition.collectionId}`
    );
  } catch (error: any) {
    spinner.fail(`Failed to create collection: ${error.message}`);
    console.error("\nMake sure you have AWS credentials configured:");
    console.error("  export AWS_ACCESS_KEY_ID=your_key");
    console.error("  export AWS_SECRET_ACCESS_KEY=your_secret");
    console.error("  export AWS_REGION=us-east-1");
    process.exit(1);
  }

  console.log("\nInitialization complete!");
  console.log("\nNext steps:");
  console.log(
    "1. Add reference photos to ./references/<person_name>/ folders"
  );
  console.log("2. Run: claude-book train");
  console.log("3. Run: claude-book scan -p ~/Pictures/Family");
}
