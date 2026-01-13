import ora from "ora";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import type { ReviewState } from "./scan";
import {
  getAlbumPhotos,
  addPhotosToAlbum,
} from "../export/albums";
import {
  initDatabase,
  getPerson,
  getPhotoByHash,
  addCorrection,
  getAllPersons,
} from "../db";
import { computeFileHash } from "../utils/hash";

const REVIEW_STATE_FILE = ".claude-book-review.json";

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

interface CorrectionOptions {
  person: string;
  photo?: string;
  all?: boolean;
}

/**
 * Approve a recognition match (mark as correct)
 */
export async function approveMatchCommand(options: CorrectionOptions): Promise<void> {
  initDatabase();
  const spinner = ora();

  // Validate person exists
  const person = getPerson(options.person);
  if (!person) {
    const allPersons = getAllPersons();
    console.error(`Person "${options.person}" not found.`);
    if (allPersons.length > 0) {
      console.error("\nAvailable people:");
      for (const p of allPersons) {
        console.error(`  - ${p.name}`);
      }
    }
    process.exit(1);
  }

  if (options.photo) {
    // Approve single photo
    const photoPath = expandPath(options.photo);
    if (!existsSync(photoPath)) {
      console.error(`Photo not found: ${photoPath}`);
      process.exit(1);
    }

    spinner.start("Computing file hash...");
    const hash = await computeFileHash(photoPath);
    spinner.succeed("Hash computed");

    const photo = getPhotoByHash(hash);
    if (!photo) {
      console.error("Photo not found in database. Run 'claude-book scan' first.");
      process.exit(1);
    }

    // Check if person is in recognitions
    const hasRecognition = photo.recognitions.some(r => r.personId === person.id);
    if (!hasRecognition) {
      console.error(`"${person.name}" was not detected in this photo.`);
      console.error("Use 'claude-book add-match' to manually add a match.");
      process.exit(1);
    }

    const success = addCorrection(hash, person.id, person.name, "approved");
    if (success) {
      console.log(`\n✓ Approved: "${person.name}" is correctly identified in ${photoPath}`);
    } else {
      console.error("Failed to record correction.");
      process.exit(1);
    }
  } else if (options.all) {
    // Approve all current matches for this person
    console.log(`Approving all matches for "${person.name}"...`);
    console.log("(This feature is not yet implemented - use --photo to approve individual photos)");
    process.exit(1);
  } else {
    console.error("Please specify --photo or --all");
    process.exit(1);
  }
}

/**
 * Reject a recognition match (mark as false positive)
 */
export async function rejectMatchCommand(options: CorrectionOptions): Promise<void> {
  initDatabase();
  const spinner = ora();

  // Validate person exists
  const person = getPerson(options.person);
  if (!person) {
    const allPersons = getAllPersons();
    console.error(`Person "${options.person}" not found.`);
    if (allPersons.length > 0) {
      console.error("\nAvailable people:");
      for (const p of allPersons) {
        console.error(`  - ${p.name}`);
      }
    }
    process.exit(1);
  }

  if (!options.photo) {
    console.error("Please specify --photo");
    process.exit(1);
  }

  const photoPath = expandPath(options.photo);
  if (!existsSync(photoPath)) {
    console.error(`Photo not found: ${photoPath}`);
    process.exit(1);
  }

  spinner.start("Computing file hash...");
  const hash = await computeFileHash(photoPath);
  spinner.succeed("Hash computed");

  const photo = getPhotoByHash(hash);
  if (!photo) {
    console.error("Photo not found in database. Run 'claude-book scan' first.");
    process.exit(1);
  }

  const success = addCorrection(hash, person.id, person.name, "false_positive");
  if (success) {
    console.log(`\n✓ Recorded: "${person.name}" is NOT in ${photoPath}`);
    console.log("This photo will be excluded from future matches for this person.");
  } else {
    console.error("Failed to record correction.");
    process.exit(1);
  }
}

/**
 * Manually add a match (mark as false negative - person was missed)
 */
export async function addMatchCommand(options: CorrectionOptions): Promise<void> {
  initDatabase();
  const spinner = ora();

  // Validate person exists
  const person = getPerson(options.person);
  if (!person) {
    const allPersons = getAllPersons();
    console.error(`Person "${options.person}" not found.`);
    if (allPersons.length > 0) {
      console.error("\nAvailable people:");
      for (const p of allPersons) {
        console.error(`  - ${p.name}`);
      }
    }
    process.exit(1);
  }

  if (!options.photo) {
    console.error("Please specify --photo");
    process.exit(1);
  }

  const photoPath = expandPath(options.photo);
  if (!existsSync(photoPath)) {
    console.error(`Photo not found: ${photoPath}`);
    process.exit(1);
  }

  spinner.start("Computing file hash...");
  const hash = await computeFileHash(photoPath);
  spinner.succeed("Hash computed");

  const photo = getPhotoByHash(hash);
  if (!photo) {
    console.error("Photo not found in database. Run 'claude-book scan' first.");
    process.exit(1);
  }

  // Check if person is already in recognitions
  const hasRecognition = photo.recognitions.some(r => r.personId === person.id);
  if (hasRecognition) {
    console.log(`"${person.name}" is already detected in this photo.`);
    console.log("Use 'claude-book approve' to confirm the match.");
    return;
  }

  const success = addCorrection(hash, person.id, person.name, "false_negative");
  if (success) {
    console.log(`\n✓ Added: "${person.name}" manually added to ${photoPath}`);
    console.log("This match will be included in future scans.");
  } else {
    console.error("Failed to record correction.");
    process.exit(1);
  }
}

/**
 * Original approve command - approves review albums and creates final albums
 */
export async function approveCommand(): Promise<void> {
  const spinner = ora();

  // Check if review state exists
  if (!existsSync(REVIEW_STATE_FILE)) {
    console.log("No pending review found.");
    console.log("Run 'claude-book scan <path>' first to create review albums.");
    return;
  }

  // Load review state
  const reviewState: ReviewState = JSON.parse(
    readFileSync(REVIEW_STATE_FILE, "utf-8")
  );

  const people = Object.keys(reviewState.people);
  if (people.length === 0) {
    console.log("No review albums found in state.");
    unlinkSync(REVIEW_STATE_FILE);
    return;
  }

  console.log(`Found ${people.length} review album(s) from ${reviewState.createdAt}:\n`);

  // Get current photos from each review album
  const albumPhotos = new Map<string, string[]>();

  for (const person of people) {
    const info = reviewState.people[person];
    spinner.start(`Checking "${info.reviewAlbum}"...`);

    const photos = await getAlbumPhotos(info.reviewAlbum);
    const photoPaths = photos.map(p => p.path);
    albumPhotos.set(person, photoPaths);

    const removed = info.photoCount - photoPaths.length;
    if (removed > 0) {
      spinner.succeed(`${info.reviewAlbum}: ${photoPaths.length} photos (${removed} removed during review)`);
    } else {
      spinner.succeed(`${info.reviewAlbum}: ${photoPaths.length} photos`);
    }
  }

  // Create final albums
  console.log("\nCreating final albums...\n");

  for (const person of people) {
    const photos = albumPhotos.get(person) ?? [];
    const finalAlbum = `${reviewState.albumPrefix}: ${person}`;

    if (photos.length === 0) {
      spinner.info(`Skipping "${finalAlbum}" (no photos in review album)`);
      continue;
    }

    spinner.start(`Creating "${finalAlbum}"...`);
    const result = await addPhotosToAlbum(finalAlbum, photos);

    if (result.errors.length === 0) {
      spinner.succeed(`"${finalAlbum}": ${result.photosAdded} photos`);
    } else {
      spinner.fail(`"${finalAlbum}": ${result.errors.join(", ")}`);
    }
  }

  // Clean up state file
  unlinkSync(REVIEW_STATE_FILE);

  console.log("\nDone! Photos have been copied to final albums.");
  console.log("Review albums have been kept in Apple Photos.");
}
