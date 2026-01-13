import ora from "ora";
import cliProgress from "cli-progress";
import { loadConfig } from "../config";
import { FaceRecognitionClient } from "../rekognition/client";
import { scanReferencesDirectory } from "../sources/local";
import { initDatabase, createPerson, updatePersonFaceCount } from "../db";

interface TrainOptions {
  references?: string;
}

export async function trainCommand(options: TrainOptions): Promise<void> {
  const config = loadConfig();
  const referencesPath = options.references ?? config.training.referencesPath;

  const spinner = ora();

  // Initialize database
  spinner.start("Initializing database...");
  initDatabase();
  spinner.succeed("Database initialized");

  // Scan references directory
  spinner.start("Scanning references directory...");
  const people = scanReferencesDirectory(
    referencesPath,
    config.sources.local.extensions
  );

  if (people.size === 0) {
    spinner.fail(`No reference photos found in: ${referencesPath}`);
    console.error("\nExpected structure:");
    console.error("  references/");
    console.error("  ├── mom/");
    console.error("  │   ├── photo1.jpg");
    console.error("  │   └── photo2.jpg");
    console.error("  └── dad/");
    console.error("      └── photo1.jpg");
    process.exit(1);
  }

  let totalPhotos = 0;
  for (const photos of people.values()) {
    totalPhotos += photos.length;
  }

  spinner.succeed(
    `Found ${people.size} people with ${totalPhotos} reference photos`
  );

  // Initialize client
  const client = new FaceRecognitionClient(
    config.aws.region,
    config.rekognition.collectionId,
    config.rekognition.minConfidence
  );

  // Index faces
  const progressBar = new cliProgress.SingleBar(
    {
      format: "Training |{bar}| {percentage}% | {value}/{total} | {person}",
    },
    cliProgress.Presets.shades_classic
  );

  progressBar.start(totalPhotos, 0, { person: "" });

  const results: { person: string; personId: number; indexed: number; errors: string[] }[] = [];

  for (const [personName, photos] of people) {
    // Create person record in database
    const person = createPerson(personName);
    const personResult = { person: personName, personId: person.id, indexed: 0, errors: [] as string[] };

    for (const photoPath of photos) {
      progressBar.increment({ person: personName });

      try {
        const face = await client.indexFace(photoPath, personName);
        if (face) {
          personResult.indexed++;
        } else {
          personResult.errors.push(`No face detected: ${photoPath}`);
        }
      } catch (error: any) {
        personResult.errors.push(`${photoPath}: ${error.message}`);
      }
    }

    // Update face count in database
    updatePersonFaceCount(person.id, personResult.indexed);
    results.push(personResult);
  }

  progressBar.stop();

  // Print summary
  console.log("\nTraining complete!\n");
  console.log("Results:");
  for (const result of results) {
    const status = result.indexed > 0 ? "✓" : "✗";
    console.log(`  ${status} ${result.person}: ${result.indexed} faces indexed`);
    for (const error of result.errors) {
      console.log(`    ⚠ ${error}`);
    }
  }

  const totalIndexed = results.reduce((sum, r) => sum + r.indexed, 0);
  console.log(`\nTotal: ${totalIndexed} faces indexed for ${people.size} people`);
}
