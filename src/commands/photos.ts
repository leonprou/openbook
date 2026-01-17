import ora from "ora";
import { existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { resolve, dirname, basename } from "path";
import { printPhotoTable, type PhotoRow } from "../utils/table";
import { extractDateFromFilename } from "../sources/local";

/**
 * Extract a sortable key from a filename for chronological ordering in display.
 */
function extractSortKeyForDisplay(filename: string): string {
  // Pattern 1: Telegram format - photo_<id>@DD-MM-YYYY_HH-MM-SS
  const telegramMatch = filename.match(
    /(\d+)@(\d{2})-(\d{2})-(\d{4})_(\d{2})-(\d{2})-(\d{2})/
  );
  if (telegramMatch) {
    const [, id, d, m, y, h, min, s] = telegramMatch;
    // Include padded ID as secondary sort key for same-timestamp photos
    return `1${y}${m}${d}${h}${min}${s}_${id.padStart(10, "0")}`;
  }

  // Pattern 2: Numeric ID after prefix (IMG_0001, DSC_1234)
  const idMatch = filename.match(/^[A-Z]{2,5}[_-]?(\d+)/i);
  if (idMatch) {
    return "0" + idMatch[1].padStart(10, "0");
  }

  // Pattern 3: YYYYMMDD with optional HHMMSS
  const dateTimeMatch = filename.match(
    /(\d{4})[-_]?(\d{2})[-_]?(\d{2})[-_]?(\d{2})?[-_]?(\d{2})?[-_]?(\d{2})?/
  );
  if (dateTimeMatch) {
    const [, y, m, d, h = "00", min = "00", s = "00"] = dateTimeMatch;
    return `1${y}${m}${d}${h}${min}${s}`;
  }

  // Fallback: alphabetical
  return "2" + filename.toLowerCase();
}
import { homedir } from "os";
import { spawn } from "child_process";
import {
  initDatabase,
  getPerson,
  getPhotoByHash,
  addCorrection,
  getAllPersons,
  getPhotosByScan,
  getLastScan,
  type Photo,
  type Recognition,
  type Correction,
} from "../db";
import { computeFileHash } from "../utils/hash";
import { loadConfig } from "../config";
import { addPhotosToAlbum } from "../export/albums";
import { Database } from "bun:sqlite";

const SESSION_FILE = ".claude-book-session.json";

// Photo status types
type PhotoStatus = "pending" | "approved" | "rejected" | "manual" | "all";

interface PhotoFilter {
  person?: string;
  status?: PhotoStatus;
  scanId?: number;
  limit?: number;
  offset?: number;
  minConfidence?: number;
  maxConfidence?: number;
}

interface PhotoResult {
  index: number;
  hash: string;
  path: string;
  person: string;
  confidence: number;
  status: PhotoStatus;
  scanId: number | null;
  scannedAt: string;
  date?: Date;
}

interface LastQuery {
  filters: PhotoFilter;
  results: PhotoResult[];
  timestamp: number;
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

/**
 * Open photos in macOS Preview
 */
function openPhotosInPreview(paths: string[]): void {
  if (paths.length === 0) return;
  spawn("open", paths, { detached: true, stdio: "ignore" });
}

/**
 * Get the status of a recognition based on corrections
 */
function getRecognitionStatus(
  personId: number,
  corrections: Correction[]
): PhotoStatus {
  const correction = corrections.find((c) => c.personId === personId);
  if (!correction) return "pending";

  switch (correction.type) {
    case "approved":
      return "approved";
    case "false_positive":
      return "rejected";
    case "false_negative":
      return "manual";
    default:
      return "pending";
  }
}

/**
 * Query photos with filters
 */
function queryPhotos(filter: PhotoFilter): PhotoResult[] {
  const db = new Database(resolve(process.cwd(), ".claude-book.db"));
  const results: PhotoResult[] = [];

  // Build query based on filters
  // Show all photos by default, use --person all to filter to only recognized
  let query: string;
  if (filter.scanId) {
    query = `SELECT * FROM photos WHERE last_scan_id = ${filter.scanId}`;
  } else if (filter.person === "all") {
    // --person all: show only photos with recognitions
    query = "SELECT * FROM photos WHERE recognitions IS NOT NULL AND recognitions != '[]'";
  } else {
    query = "SELECT * FROM photos";
  }

  query += " ORDER BY last_scanned_at DESC";

  const rows = db.query(query).all() as Array<{
    hash: string;
    path: string;
    recognitions: string;
    corrections: string | null;
    last_scan_id: number | null;
    last_scanned_at: string;
  }>;

  let index = 1;

  for (const row of rows) {
    const recognitions: Recognition[] = row.recognitions ? JSON.parse(row.recognitions) : [];
    const corrections: Correction[] = row.corrections
      ? JSON.parse(row.corrections)
      : [];

    // Extract date from filename, fallback to file mtime
    let photoDate: Date | undefined;
    try {
      const filename = basename(row.path);
      photoDate = extractDateFromFilename(filename) ?? statSync(row.path).mtime;
    } catch {
      // File may not exist anymore
    }

    // Also include false negatives (manually added matches)
    const falseNegatives = corrections
      .filter((c) => c.type === "false_negative")
      .map((c) => ({
        personId: c.personId,
        personName: c.personName,
        confidence: 100,
        faceId: "",
        boundingBox: { left: 0, top: 0, width: 0, height: 0 },
      }));

    const allRecognitions = [...recognitions, ...falseNegatives];

    // Handle photos with no recognitions
    // Skip by default - only show when explicitly filtering for "(no match)"
    if (allRecognitions.length === 0) {
      continue;
    }

    for (const rec of allRecognitions) {
      const status = getRecognitionStatus(rec.personId, corrections);

      // Apply person filter (skip if "all" - show all people)
      if (filter.person && filter.person !== "all" && rec.personName !== filter.person) {
        continue;
      }

      // Apply status filter
      if (filter.status && filter.status !== "all" && status !== filter.status) {
        continue;
      }

      // Apply confidence filters
      if (filter.minConfidence !== undefined && rec.confidence < filter.minConfidence) {
        continue;
      }
      if (filter.maxConfidence !== undefined && rec.confidence > filter.maxConfidence) {
        continue;
      }

      results.push({
        index,
        hash: row.hash,
        path: row.path,
        person: rec.personName,
        confidence: rec.confidence,
        status,
        scanId: row.last_scan_id,
        scannedAt: row.last_scanned_at,
        date: photoDate,
      });

      index++;
    }
  }

  db.close();

  // Apply offset and limit
  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? 250;

  return results.slice(offset, offset + limit);
}

/**
 * Save last query to session file
 */
function saveLastQuery(filters: PhotoFilter, results: PhotoResult[]): void {
  const session: LastQuery = {
    filters,
    results,
    timestamp: Date.now(),
  };

  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

/**
 * Load last query from session file
 */
function loadLastQuery(): LastQuery | null {
  if (!existsSync(SESSION_FILE)) {
    return null;
  }

  try {
    const content = readFileSync(SESSION_FILE, "utf-8");
    const session = JSON.parse(content) as LastQuery;

    // Check if session is still valid (15 minutes)
    const age = Date.now() - session.timestamp;
    if (age > 15 * 60 * 1000) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

/**
 * Parse index string into number array
 * Supports: "1", "1,2,4", "1-5", "1,3-5,8"
 */
function parseIndexes(str: string): number[] {
  const indexes: number[] = [];
  const parts = str.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map((s) => parseInt(s.trim(), 10));
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = start; i <= end; i++) {
          indexes.push(i);
        }
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num)) {
        indexes.push(num);
      }
    }
  }

  return [...new Set(indexes)].sort((a, b) => a - b);
}

// Command interfaces
interface PhotosListOptions {
  person?: string;
  status?: string;
  scan?: number | string;
  open?: boolean;
  limit?: number;
  offset?: number;
  json?: boolean;
  minConfidence?: number;
  maxConfidence?: number;
}

interface PhotosApproveOptions {
  all?: boolean;
  without?: string;
  dryRun?: boolean;
  minConfidence?: number;
  maxConfidence?: number;
}

interface PhotosRejectOptions {
  all?: boolean;
  without?: string;
  minConfidence?: number;
  maxConfidence?: number;
  person?: string;
  dryRun?: boolean;
}

interface PhotosExportOptions {
  person?: string;
  album?: string;
}

/**
 * Determine default status based on filters
 */
function getDefaultStatus(_options: PhotosListOptions): PhotoStatus {
  return "all";
}

/**
 * photos - List photos with filters
 */
export async function photosListCommand(options: PhotosListOptions): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Run 'claude-book scan' first.");
    return;
  }

  const config = loadConfig();
  const status = (options.status as PhotoStatus) ?? getDefaultStatus(options);

  // Resolve "latest" to actual scan ID
  let scanId: number | undefined;
  if (options.scan === "latest") {
    const lastScan = getLastScan();
    if (!lastScan) {
      console.log("No scans found. Run 'claude-book scan' first.");
      return;
    }
    scanId = lastScan.id;
    console.log(`Using latest scan #${scanId}`);
  } else if (typeof options.scan === "number") {
    scanId = options.scan;
  } else if (typeof options.scan === "string") {
    scanId = parseInt(options.scan, 10);
  }

  const filter: PhotoFilter = {
    person: options.person,
    status,
    scanId,
    limit: options.limit ?? config.display.photoLimit,
    offset: options.offset ?? 0,
    minConfidence: options.minConfidence,
    maxConfidence: options.maxConfidence,
  };

  const results = queryPhotos(filter);

  // Sort results chronologically by filename
  results.sort((a, b) => {
    const keyA = extractSortKeyForDisplay(basename(a.path));
    const keyB = extractSortKeyForDisplay(basename(b.path));
    return keyA.localeCompare(keyB);
  });

  // Re-assign indexes after sorting
  results.forEach((photo, i) => {
    photo.index = i + 1;
  });

  if (results.length === 0) {
    console.log("No photos found matching filters.");
    if (filter.status !== "all") {
      console.log(`Try using --status all to see all photos.`);
    }
    return;
  }

  // Save to session for index-based commands
  saveLastQuery(filter, results);

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Print table
  console.log();
  printPhotoTable(results);

  console.log();
  console.log(`Showing ${results.length} photos.`);

  // Open photos in Preview if requested
  if (options.open && results.length > 0) {
    const paths = [...new Set(results.map((p) => p.path))];
    openPhotosInPreview(paths);
    console.log(`Opened ${paths.length} photos in Preview.`);
  }

  console.log();
  console.log("Commands:");
  console.log("  claude-book photos approve <indexes>      Approve by index (1,2,4-6)");
  console.log("  claude-book photos approve --all          Approve all shown");
  console.log("  claude-book photos reject <indexes>       Reject by index");
}

/**
 * photos approve - Approve photo recognitions
 */
export async function photosApproveCommand(
  indexesOrPerson?: string,
  path?: string,
  options: PhotosApproveOptions = {}
): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Run 'claude-book scan' first.");
    return;
  }

  // Check if this is person + path format
  if (indexesOrPerson && path) {
    await approveByPersonPath(indexesOrPerson, path, options.dryRun);
    return;
  }

  // Index-based approval
  const lastQuery = loadLastQuery();
  if (!lastQuery) {
    console.log("No recent photo list found. Run 'claude-book photos' first.");
    return;
  }

  let toApprove: PhotoResult[];

  if (options.all) {
    toApprove = [...lastQuery.results];

    // Exclude specified indexes
    if (options.without) {
      const excludeIndexes = new Set(parseIndexes(options.without));
      toApprove = toApprove.filter((p) => !excludeIndexes.has(p.index));
    }

    // Apply confidence filters
    if (options.minConfidence !== undefined) {
      toApprove = toApprove.filter((p) => p.confidence >= options.minConfidence!);
    }
    if (options.maxConfidence !== undefined) {
      toApprove = toApprove.filter((p) => p.confidence <= options.maxConfidence!);
    }
  } else if (indexesOrPerson) {
    const approveIndexes = new Set(parseIndexes(indexesOrPerson));
    toApprove = lastQuery.results.filter((p) => approveIndexes.has(p.index));
  } else {
    console.log("Please specify indexes or use --all");
    return;
  }

  if (toApprove.length === 0) {
    console.log("No photos to approve. Check your indexes.");
    return;
  }

  if (options.dryRun) {
    console.log(`[Dry run] Would approve ${toApprove.length} photos:`);
    for (const photo of toApprove) {
      console.log(`  [${photo.index}] ${photo.person} - ${photo.path}`);
    }
    return;
  }

  // Apply corrections
  let count = 0;
  for (const photo of toApprove) {
    const person = getPerson(photo.person);
    if (person) {
      const success = addCorrection(photo.hash, person.id, person.name, "approved");
      if (success) count++;
    }
  }

  console.log(`✓ Approved ${count} photos`);
  if (options.without) {
    const skipped = lastQuery.results.length - toApprove.length;
    console.log(`  (skipped ${skipped})`);
  }
}

/**
 * Approve a specific photo by person and path
 */
async function approveByPersonPath(
  personName: string,
  photoPath: string,
  dryRun?: boolean
): Promise<void> {
  const person = getPerson(personName);
  if (!person) {
    const allPersons = getAllPersons();
    console.error(`Person "${personName}" not found.`);
    if (allPersons.length > 0) {
      console.error("\nAvailable people:");
      for (const p of allPersons) {
        console.error(`  - ${p.name}`);
      }
    }
    process.exit(1);
  }

  const expandedPath = expandPath(photoPath);
  if (!existsSync(expandedPath)) {
    console.error(`Photo not found: ${expandedPath}`);
    process.exit(1);
  }

  const spinner = ora();
  spinner.start("Computing file hash...");
  const hash = await computeFileHash(expandedPath);
  spinner.stop();

  const photo = getPhotoByHash(hash);
  if (!photo) {
    console.error("Photo not found in database. Run 'claude-book scan' first.");
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[Dry run] Would approve: "${person.name}" in ${expandedPath}`);
    return;
  }

  const success = addCorrection(hash, person.id, person.name, "approved");
  if (success) {
    console.log(`✓ Approved: "${person.name}" is correctly identified in ${expandedPath}`);
  } else {
    console.error("Failed to record correction.");
    process.exit(1);
  }
}

/**
 * photos reject - Reject photo recognitions
 */
export async function photosRejectCommand(
  indexesOrPerson?: string,
  path?: string,
  options: PhotosRejectOptions = {}
): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Run 'claude-book scan' first.");
    return;
  }

  // Check if this is person + path format
  if (indexesOrPerson && path) {
    await rejectByPersonPath(indexesOrPerson, path, options.dryRun);
    return;
  }

  // Handle standalone confidence-based rejection (without --all)
  if (!options.all && options.maxConfidence !== undefined && !indexesOrPerson) {
    await rejectByMaxConfidence(options.maxConfidence, options.person, options.dryRun);
    return;
  }

  // Index-based rejection
  const lastQuery = loadLastQuery();
  if (!lastQuery) {
    console.log("No recent photo list found. Run 'claude-book photos' first.");
    return;
  }

  let toReject: PhotoResult[];

  if (options.all) {
    toReject = [...lastQuery.results];

    // Exclude specified indexes
    if (options.without) {
      const excludeIndexes = new Set(parseIndexes(options.without));
      toReject = toReject.filter((p) => !excludeIndexes.has(p.index));
    }

    // Apply confidence filters
    if (options.minConfidence !== undefined) {
      toReject = toReject.filter((p) => p.confidence >= options.minConfidence!);
    }
    if (options.maxConfidence !== undefined) {
      toReject = toReject.filter((p) => p.confidence <= options.maxConfidence!);
    }
  } else if (indexesOrPerson) {
    const rejectIndexes = new Set(parseIndexes(indexesOrPerson));
    toReject = lastQuery.results.filter((p) => rejectIndexes.has(p.index));
  } else {
    console.log("Please specify indexes, use --all, or use --max-confidence");
    return;
  }

  if (toReject.length === 0) {
    console.log("No photos to reject. Check your indexes.");
    return;
  }

  if (options.dryRun) {
    console.log(`[Dry run] Would reject ${toReject.length} photos:`);
    for (const photo of toReject) {
      console.log(`  [${photo.index}] ${photo.person} (${photo.confidence.toFixed(1)}%) - ${photo.path}`);
    }
    return;
  }

  // Apply corrections
  let count = 0;
  for (const photo of toReject) {
    const person = getPerson(photo.person);
    if (person) {
      const success = addCorrection(photo.hash, person.id, person.name, "false_positive");
      if (success) count++;
    }
  }

  console.log(`✓ Rejected ${count} photos`);
  if (options.without) {
    const skipped = lastQuery.results.length - toReject.length;
    console.log(`  (skipped ${skipped})`);
  }
}

/**
 * Reject a specific photo by person and path
 */
async function rejectByPersonPath(
  personName: string,
  photoPath: string,
  dryRun?: boolean
): Promise<void> {
  const person = getPerson(personName);
  if (!person) {
    const allPersons = getAllPersons();
    console.error(`Person "${personName}" not found.`);
    if (allPersons.length > 0) {
      console.error("\nAvailable people:");
      for (const p of allPersons) {
        console.error(`  - ${p.name}`);
      }
    }
    process.exit(1);
  }

  const expandedPath = expandPath(photoPath);
  if (!existsSync(expandedPath)) {
    console.error(`Photo not found: ${expandedPath}`);
    process.exit(1);
  }

  const spinner = ora();
  spinner.start("Computing file hash...");
  const hash = await computeFileHash(expandedPath);
  spinner.stop();

  const photo = getPhotoByHash(hash);
  if (!photo) {
    console.error("Photo not found in database. Run 'claude-book scan' first.");
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[Dry run] Would reject: "${person.name}" in ${expandedPath}`);
    return;
  }

  const success = addCorrection(hash, person.id, person.name, "false_positive");
  if (success) {
    console.log(`✓ Rejected: "${person.name}" is NOT in ${expandedPath}`);
    console.log("This photo will be excluded from future matches for this person.");
  } else {
    console.error("Failed to record correction.");
    process.exit(1);
  }
}

/**
 * Reject photos by max confidence threshold
 */
async function rejectByMaxConfidence(
  maxConfidence: number,
  personFilter?: string,
  dryRun?: boolean
): Promise<void> {
  const filter: PhotoFilter = {
    person: personFilter,
    status: "pending",
    limit: 1000, // Get all pending
  };

  const results = queryPhotos(filter);
  const toReject = results.filter((p) => p.confidence <= maxConfidence);

  if (toReject.length === 0) {
    console.log(`No pending photos with confidence ≤ ${maxConfidence}%`);
    return;
  }

  if (dryRun) {
    console.log(`[Dry run] Would reject ${toReject.length} photos with confidence ≤ ${maxConfidence}%:`);
    for (const photo of toReject.slice(0, 10)) {
      console.log(`  ${photo.person} (${photo.confidence.toFixed(1)}%) - ${photo.path}`);
    }
    if (toReject.length > 10) {
      console.log(`  ... and ${toReject.length - 10} more`);
    }
    return;
  }

  // Apply corrections
  let count = 0;
  for (const photo of toReject) {
    const person = getPerson(photo.person);
    if (person) {
      const success = addCorrection(photo.hash, person.id, person.name, "false_positive");
      if (success) count++;
    }
  }

  console.log(`✓ Rejected ${count} photos with confidence ≤ ${maxConfidence}%`);
}

/**
 * photos add - Manually add person to photo
 */
export async function photosAddCommand(
  personName: string,
  photoPath: string
): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Run 'claude-book scan' first.");
    return;
  }

  const person = getPerson(personName);
  if (!person) {
    const allPersons = getAllPersons();
    console.error(`Person "${personName}" not found.`);
    if (allPersons.length > 0) {
      console.error("\nAvailable people:");
      for (const p of allPersons) {
        console.error(`  - ${p.name}`);
      }
    }
    process.exit(1);
  }

  const expandedPath = expandPath(photoPath);
  if (!existsSync(expandedPath)) {
    console.error(`Photo not found: ${expandedPath}`);
    process.exit(1);
  }

  const spinner = ora();
  spinner.start("Computing file hash...");
  const hash = await computeFileHash(expandedPath);
  spinner.stop();

  const photo = getPhotoByHash(hash);
  if (!photo) {
    console.error("Photo not found in database. Run 'claude-book scan' first.");
    process.exit(1);
  }

  // Check if person is already in recognitions
  const hasRecognition = photo.recognitions.some((r) => r.personId === person.id);
  if (hasRecognition) {
    console.log(`"${person.name}" is already detected in this photo.`);
    console.log("Use 'claude-book photos approve' to confirm the match.");
    return;
  }

  const success = addCorrection(hash, person.id, person.name, "false_negative");
  if (success) {
    console.log(`✓ Added: "${person.name}" manually added to ${expandedPath}`);
    console.log("This match will be included in future exports.");
  } else {
    console.error("Failed to record correction.");
    process.exit(1);
  }
}

/**
 * photos export - Export approved photos to Apple Photos
 */
export async function photosExportCommand(options: PhotosExportOptions): Promise<void> {
  try {
    initDatabase();
  } catch {
    console.log("Database not initialized. Run 'claude-book scan' first.");
    return;
  }

  const config = loadConfig();
  const spinner = ora();

  // Get all approved photos
  const filter: PhotoFilter = {
    person: options.person,
    status: "approved",
    limit: 10000, // Get all approved
  };

  const results = queryPhotos(filter);

  if (results.length === 0) {
    console.log("No approved photos to export.");
    if (options.person) {
      console.log(`No approved photos found for "${options.person}".`);
    }
    console.log("Use 'claude-book photos approve' to approve photos first.");
    return;
  }

  // Group by person
  const personPhotos = new Map<string, string[]>();
  for (const result of results) {
    const existing = personPhotos.get(result.person) ?? [];
    if (!existing.includes(result.path)) {
      existing.push(result.path);
    }
    personPhotos.set(result.person, existing);
  }

  console.log(`Exporting ${results.length} approved photos for ${personPhotos.size} people...\n`);

  // Create albums
  for (const [personName, photoPaths] of personPhotos) {
    const albumName = options.album ?? `${config.albums.prefix}: ${personName}`;

    spinner.start(`Creating "${albumName}"...`);
    const result = await addPhotosToAlbum(albumName, photoPaths);

    if (result.errors.length === 0) {
      spinner.succeed(`"${albumName}": ${result.photosAdded} photos`);
    } else {
      spinner.fail(`"${albumName}": ${result.errors.join(", ")}`);
    }
  }

  console.log("\nDone! Photos exported to Apple Photos.");
}
