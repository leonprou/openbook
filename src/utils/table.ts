import { basename, dirname } from "path";

export interface PhotoRow {
  index: number;
  person: string;
  confidence: number;
  status: string;
  path: string;
  date?: Date;
}

export interface ColumnWidths {
  personName: number;
  folder: number;
  filename: number;
}

const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  personName: 12,
  folder: 16,
  filename: 35,
};

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
export function printPhotoTable(rows: PhotoRow[], columns?: ColumnWidths): void {
  const { personName, folder: folderWidth, filename: filenameWidth } = columns ?? DEFAULT_COLUMN_WIDTHS;

  const personHeader = "Person".padEnd(personName);
  const folderHeader = "Folder".padEnd(folderWidth);
  console.log(` #   ${personHeader} Confidence  Status     Date        ${folderHeader} Filename`);
  console.log("─".repeat(55 + personName + folderWidth + filenameWidth));

  for (const row of rows) {
    const personPadded = row.person.slice(0, personName).padEnd(personName);
    const confStr = `${row.confidence.toFixed(1)}%`.padEnd(11);
    const statusPadded = row.status.padEnd(10);
    const dateStr = formatDate(row.date);

    // Extract folder and filename
    const folder = basename(dirname(row.path));
    const folderTrunc =
      folder.length > folderWidth ? folder.slice(0, folderWidth - 3) + "..." : folder.padEnd(folderWidth);
    const filename = basename(row.path);
    const filenameTrunc =
      filename.length > filenameWidth ? filename.slice(0, filenameWidth - 3) + "..." : filename;

    console.log(
      ` ${String(row.index).padStart(2)}  ${personPadded} ${confStr} ${statusPadded} ${dateStr}  ${folderTrunc} ${filenameTrunc}`
    );
  }
}
