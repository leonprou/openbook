import { readdirSync, statSync } from "fs";
import { join, extname, basename } from "path";
import type { PhotoInfo, PhotoSource } from "./types";
import { createLogger } from "../logger";
import { extractDateFromFilename } from "../utils/date";

export { extractDateFromFilename } from "../utils/date";

const logger = createLogger("local-source");
const DEFAULT_MAX_SORT_BUFFER = 100000;

/**
 * Extract a sortable key from a filename for chronological ordering.
 * Sort order: IDs (prefix "0") → Dates (prefix "1") → Alphabetical (prefix "2")
 */
function extractSortKey(filename: string): string {
  // Pattern 1: Telegram format - photo_<id>@DD-MM-YYYY_HH-MM-SS
  // Example: photo_29425@03-10-2025_15-15-15.jpg
  const telegramMatch = filename.match(
    /(\d+)@(\d{2})-(\d{2})-(\d{4})_(\d{2})-(\d{2})-(\d{2})/
  );
  if (telegramMatch) {
    const [, id, d, m, y, h, min, s] = telegramMatch;
    // Include padded ID as secondary sort key for same-timestamp photos
    return `1${y}${m}${d}${h}${min}${s}_${id.padStart(10, "0")}`;
  }

  // Pattern 2: Numeric ID after prefix (IMG_0001, DSC_1234, P1010001)
  const idMatch = filename.match(/^[A-Z]{2,5}[_-]?(\d+)/i);
  if (idMatch) {
    return "0" + idMatch[1].padStart(10, "0");
  }

  // Pattern 3: Leading numeric ID (0001_photo, 1234.jpg)
  const leadingIdMatch = filename.match(/^(\d{1,6})(?!\d)/);
  if (leadingIdMatch) {
    return "0" + leadingIdMatch[1].padStart(10, "0");
  }

  // Pattern 4: YYYYMMDD with optional HHMMSS
  // Matches: 20231225_143052, 2023-12-25_14-30-52
  const dateTimeMatch = filename.match(
    /(\d{4})[-_]?(\d{2})[-_]?(\d{2})[-_]?(\d{2})?[-_]?(\d{2})?[-_]?(\d{2})?/
  );
  if (dateTimeMatch) {
    const [, y, m, d, h = "00", min = "00", s = "00"] = dateTimeMatch;
    return `1${y}${m}${d}${h}${min}${s}`;
  }

  // Fallback: alphabetical (sorts last)
  return "2" + filename.toLowerCase();
}

export interface DirectoryChecker {
  /** Returns cached file count if directory should be skipped, or null to scan it */
  shouldSkip(dirPath: string, mtimeMs: number): number | null;
  /** Called after scanning a directory with the file count found */
  onScanned(dirPath: string, mtimeMs: number, fileCount: number): void;
}

export interface LocalPhotoSourceOptions {
  limit?: number;
  filter?: RegExp;
  exclude?: string[];
  after?: Date;   // Only include photos after this date
  before?: Date;  // Only include photos before this date
  maxSortBuffer?: number;  // Max files to sort in memory per directory
  directoryChecker?: DirectoryChecker;
  explicitFiles?: string[];  // Specific files to scan (bypasses directory walking)
}

export class LocalPhotoSource implements PhotoSource {
  name = "local";
  private paths: string[];
  private extensions: Set<string>;
  private limit?: number;
  private filter?: RegExp;
  private exclude?: string[];
  private after?: Date;
  private before?: Date;
  private maxSortBuffer: number;
  private directoryChecker?: DirectoryChecker;
  private explicitFiles?: string[];
  public skippedDirs = 0;
  public skippedFiles = 0;
  public walkedDirs = 0;

  constructor(paths: string[], extensions: string[], options?: LocalPhotoSourceOptions) {
    this.paths = paths;
    this.extensions = new Set(extensions.map((e) => e.toLowerCase()));
    this.limit = options?.limit;
    this.filter = options?.filter;
    this.exclude = options?.exclude?.map((p) => p.toLowerCase());
    this.after = options?.after;
    this.before = options?.before;
    this.maxSortBuffer = options?.maxSortBuffer ?? DEFAULT_MAX_SORT_BUFFER;
    this.directoryChecker = options?.directoryChecker;
    this.explicitFiles = options?.explicitFiles;
  }

  async *scan(): AsyncGenerator<PhotoInfo> {
    let yielded = 0;

    if (this.explicitFiles) {
      for (const filePath of this.explicitFiles) {
        if (this.limit !== undefined && yielded >= this.limit) return;
        const filename = basename(filePath);
        const ext = extname(filename).toLowerCase();
        if (!this.extensions.has(ext)) continue;
        if (this.filter && !this.filter.test(filename)) continue;
        if (this.exclude?.some((p) => filename.toLowerCase().includes(p))) continue;
        let stat;
        try { stat = statSync(filePath); } catch { continue; }
        const modifiedAt = stat.mtime;
        if (this.after || this.before) {
          const photoDate = extractDateFromFilename(filename) ?? modifiedAt;
          if (this.after && photoDate < this.after) continue;
          if (this.before && photoDate > this.before) continue;
        }
        yielded++;
        yield { path: filePath, filename, extension: ext, size: stat.size, modifiedAt };
      }
      return;
    }

    for (const basePath of this.paths) {
      for (const photo of this.scanDirectory(basePath)) {
        if (this.limit !== undefined && yielded >= this.limit) {
          return;
        }
        yielded++;
        yield photo;
      }
    }
  }

  async count(): Promise<number> {
    let count = 0;
    for await (const _ of this.scan()) {
      count++;
    }
    return count;
  }

  private *scanDirectory(dirPath: string): Generator<PhotoInfo> {
    // Check directory mtime cache to skip file processing
    let skipFiles = false;
    if (this.directoryChecker) {
      let dirStat;
      try { dirStat = statSync(dirPath); } catch { return; }
      const cached = this.directoryChecker.shouldSkip(dirPath, dirStat.mtimeMs);
      if (cached !== null) {
        skipFiles = true;
        this.skippedDirs++;
        this.skippedFiles += cached;
      } else {
        this.walkedDirs++;
      }
    } else {
      this.walkedDirs++;
    }

    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or not accessible
      return;
    }

    // Collect files and subdirectories separately for sorting
    const files: PhotoInfo[] = [];
    const subdirs: string[] = [];

    for (const entry of entries) {
      // Skip hidden files and directories
      if (entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        subdirs.push(fullPath);
      } else if (!skipFiles && entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (this.extensions.has(ext)) {
          // Apply filter (match against filename only)
          if (this.filter && !this.filter.test(entry.name)) {
            continue;
          }

          // Apply exclude patterns (case-insensitive substring match)
          if (this.exclude?.length) {
            const lowerName = entry.name.toLowerCase();
            if (this.exclude.some((pattern) => lowerName.includes(pattern))) {
              continue;
            }
          }

          try {
            const stats = statSync(fullPath);

            // Apply date filter (prefer filename date, fallback to file mtime)
            if (this.after || this.before) {
              const fileDate = extractDateFromFilename(entry.name) ?? stats.mtime;
              if (this.after && fileDate < this.after) {
                continue;
              }
              if (this.before && fileDate > this.before) {
                continue;
              }
            }

            const photoDate = extractDateFromFilename(entry.name) ?? stats.mtime;
            files.push({
              path: fullPath,
              filename: basename(entry.name, ext),
              extension: ext,
              size: stats.size,
              modifiedAt: stats.mtime,
              photoDate: photoDate.toISOString(),
            });
          } catch {
            // File not accessible, skip
          }
        }
      }
    }

    // Record directory BEFORE yielding (cache is populated even if generator abandoned)
    if (this.directoryChecker && !skipFiles) {
      let dirStat;
      try { dirStat = statSync(dirPath); } catch { /* ignore */ }
      if (dirStat) {
        this.directoryChecker.onScanned(dirPath, dirStat.mtimeMs, files.length);
      }
    }

    // Sort and yield files (with safety limit for large directories)
    if (files.length > this.maxSortBuffer) {
      logger.warn(
        { directory: dirPath, fileCount: files.length, limit: this.maxSortBuffer },
        "Directory exceeds sort limit, yielding unsorted"
      );
      for (const photo of files) {
        yield photo;
      }
    } else if (files.length > 0) {
      files.sort((a, b) =>
        extractSortKey(a.filename).localeCompare(extractSortKey(b.filename))
      );
      for (const photo of files) {
        yield photo;
      }
    }

    // Recurse into subdirectories (sorted alphabetically)
    subdirs.sort();
    for (const subdir of subdirs) {
      yield* this.scanDirectory(subdir);
    }
  }
}

export function scanReferencesDirectory(
  referencesPath: string,
  extensions: string[]
): Map<string, string[]> {
  const people = new Map<string, string[]>();
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));

  let entries;
  try {
    entries = readdirSync(referencesPath, { withFileTypes: true });
  } catch {
    return people;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const personName = entry.name;
    const personPath = join(referencesPath, personName);
    const photos: string[] = [];

    try {
      const files = readdirSync(personPath, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && !file.name.startsWith(".")) {
          const ext = extname(file.name).toLowerCase();
          if (extSet.has(ext)) {
            photos.push(join(personPath, file.name));
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }

    if (photos.length > 0) {
      people.set(personName, photos);
    }
  }

  return people;
}
