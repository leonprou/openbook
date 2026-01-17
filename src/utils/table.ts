import { basename, dirname } from "path";

export interface PhotoRow {
  index: number;
  person: string;
  confidence: number;
  status: string;
  path: string;
  date?: Date;
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date?: Date): string {
  if (!date) return "          ";
  return date.toISOString().split("T")[0];
}

/**
 * Print a formatted table of photos
 */
export function printPhotoTable(rows: PhotoRow[]): void {
  console.log(" #   Person       Confidence  Status     Date        Folder           Filename");
  console.log("─".repeat(105));

  for (const row of rows) {
    const personPadded = row.person.slice(0, 12).padEnd(12);
    const confStr = `${row.confidence.toFixed(1)}%`.padEnd(11);
    const statusPadded = row.status.padEnd(10);
    const dateStr = formatDate(row.date);

    // Extract folder and filename
    const folder = basename(dirname(row.path));
    const folderTrunc =
      folder.length > 16 ? folder.slice(0, 13) + "..." : folder.padEnd(16);
    const filename = basename(row.path);
    const filenameTrunc =
      filename.length > 35 ? filename.slice(0, 32) + "..." : filename;

    console.log(
      ` ${String(row.index).padStart(2)}  ${personPadded} ${confStr} ${statusPadded} ${dateStr}  ${folderTrunc} ${filenameTrunc}`
    );
  }
}
