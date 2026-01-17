import { confirm } from "../utils/confirm";
import { initDatabase, clearAllPhotos, getStats } from "../db";

interface ClearOptions {
  yes?: boolean;
}

/**
 * clear - Clear all photos from the database (keeps training data)
 */
export async function clearCommand(options: ClearOptions = {}): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Nothing to clear.");
    return;
  }

  const stats = getStats();
  if (stats.totalPhotos === 0) {
    console.log("No photos found. Nothing to clear.");
    return;
  }

  console.log("This will delete all photos and scans from the database.");
  console.log("Training data (persons) will be preserved.");
  console.log();

  if (!options.yes) {
    const confirmed = await confirm("Are you sure?");
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = clearAllPhotos();
  console.log(`Cleared ${result.photosCleared} photo(s) and ${result.scansCleared} scan(s).`);
}
