import ora from "ora";
import cliProgress from "cli-progress";
import { spawn } from "child_process";
import { basename } from "path";
import { loadConfig } from "../config";
import { FaceRecognitionClient } from "../rekognition/client";
import { scanReferencesDirectory } from "../sources/local";
import { initDatabase, createPerson, updatePersonFaceCount, getPerson, getAllPersons } from "../db";

interface TrainOptions {
  references?: string;
}

export async function trainCommand(
  path?: string,
  options: TrainOptions = {}
): Promise<void> {
  const config = loadConfig();

  // Deprecation warning for old syntax
  if (options.references) {
    console.warn("Warning: -r/--references is deprecated. Use positional argument instead:");
    console.warn("  claude-book train <path>");
    console.warn("");
  }

  const referencesPath = path ?? options.references ?? config.training.referencesPath;

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
  const client = new FaceRecognitionClient(config);

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

interface TrainShowOptions {
  open?: boolean;
}

function openPhotosInPreview(paths: string[]): void {
  if (paths.length === 0) return;
  spawn("open", paths, { detached: true, stdio: "ignore" });
}

export async function trainShowCommand(
  personName: string,
  options: TrainShowOptions = {}
): Promise<void> {
  const config = loadConfig();
  const referencesPath = config.training.referencesPath;

  // Initialize database to get person info
  try {
    initDatabase();
  } catch {
    // Database may not exist yet, that's ok
  }

  // Get all reference photos
  const people = scanReferencesDirectory(
    referencesPath,
    config.sources.local.extensions
  );

  // Find the requested person (case-insensitive)
  let matchedName: string | null = null;
  for (const name of people.keys()) {
    if (name.toLowerCase() === personName.toLowerCase()) {
      matchedName = name;
      break;
    }
  }

  if (!matchedName) {
    console.error(`Person "${personName}" not found in references.`);
    if (people.size > 0) {
      console.error("\nAvailable people:");
      for (const [name, photos] of people) {
        console.error(`  - ${name} (${photos.length} photos)`);
      }
    } else {
      console.error(`\nNo reference photos found in: ${referencesPath}`);
    }
    process.exit(1);
  }

  const photos = people.get(matchedName)!;

  // Get person info from database if available
  const person = getPerson(matchedName);
  const faceInfo = person ? ` (${person.faceCount} faces indexed)` : "";

  console.log(`Reference photos for "${matchedName}"${faceInfo}\n`);

  // Display table
  console.log("#    Filename                      Path");
  console.log("─".repeat(70));

  for (let i = 0; i < photos.length; i++) {
    const photoPath = photos[i];
    const filename = basename(photoPath);
    const displayFilename = filename.length > 28 ? filename.slice(0, 25) + "..." : filename;
    const displayPath = photoPath.length > 35 ? "..." + photoPath.slice(-32) : photoPath;

    console.log(
      `${String(i + 1).padEnd(5)}${displayFilename.padEnd(30)}${displayPath}`
    );
  }

  console.log(`\n${photos.length} reference photo${photos.length === 1 ? "" : "s"} found.`);

  // Handle --open flag
  if (options.open) {
    openPhotosInPreview(photos);
    console.log(`Opened ${photos.length} photos in Preview.`);
  }
}
