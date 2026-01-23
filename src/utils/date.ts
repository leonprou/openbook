import { statSync } from "fs";

/**
 * Extract a Date from a filename, or null if not found.
 */
export function extractDateFromFilename(filename: string): Date | null {
  // Pattern 1: Telegram format - photo_<id>@DD-MM-YYYY_HH-MM-SS
  const telegramMatch = filename.match(
    /(\d+)@(\d{2})-(\d{2})-(\d{4})_(\d{2})-(\d{2})-(\d{2})/
  );
  if (telegramMatch) {
    const [, , d, m, y, h, min, s] = telegramMatch;
    return new Date(
      parseInt(y), parseInt(m) - 1, parseInt(d),
      parseInt(h), parseInt(min), parseInt(s)
    );
  }

  // Pattern 2: YYYYMMDD with optional HHMMSS
  const dateTimeMatch = filename.match(
    /(\d{4})[-_]?(\d{2})[-_]?(\d{2})[-_]?(\d{2})?[-_]?(\d{2})?[-_]?(\d{2})?/
  );
  if (dateTimeMatch) {
    const [, y, m, d, h = "0", min = "0", s = "0"] = dateTimeMatch;
    return new Date(
      parseInt(y), parseInt(m) - 1, parseInt(d),
      parseInt(h), parseInt(min), parseInt(s)
    );
  }

  return null;
}

/**
 * Get photo date as ISO string from filename with fallback to file mtime.
 * Returns null if file doesn't exist and no date in filename.
 */
export function getPhotoDateISO(filePath: string, filename: string): string | null {
  const date = extractDateFromFilename(filename);
  if (date) return date.toISOString();

  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}
