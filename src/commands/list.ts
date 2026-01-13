import { initDatabase, getLastScan, getPhotosByScan } from "../db";

export async function listCommand(): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Run 'claude-book scan' first.");
    return;
  }

  const lastScan = getLastScan();
  if (!lastScan) {
    console.log("No scans found. Run 'claude-book scan' first.");
    return;
  }

  const photos = getPhotosByScan(lastScan.id);

  // Print scan info header
  const date = new Date(lastScan.startedAt);
  console.log(`Last scan: ${date.toLocaleString()}`);
  console.log(
    `Photos: ${lastScan.photosProcessed} processed, ${lastScan.matchesFound} with matches`
  );
  console.log();

  if (photos.length === 0) {
    console.log("No photos found in the latest scan.");
    return;
  }

  // Print each photo with matches
  for (const photo of photos) {
    console.log(photo.path);

    if (photo.recognitions.length === 0) {
      console.log("  (no matches)");
    } else {
      const matches = photo.recognitions
        .map((r) => `${r.personName} (${Math.round(r.confidence)}%)`)
        .join(", ");
      console.log(`  ${matches}`);
    }
  }
}
