import ora from "ora";
import { existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { resolve, dirname, basename, join } from "path";
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
import { loadConfig, getGlobalConfigDir } from "../config";
import { addPhotosToAlbum, checkOsxphotosInstalled } from "../export/albums";
import { Database } from "bun:sqlite";

function getSessionFilePath(): string {
  return join(getGlobalConfigDir(), ".openbook-session.json");
}

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
  after?: string;   // ISO 8601 date string
  before?: string;  // ISO 8601 date string
  file?: string;    // Filename substring filter
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
  facesDetected?: number;
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
function queryPhotos(filter: PhotoFilter): { results: PhotoResult[]; total: number } {
  const db = new Database(resolve(process.cwd(), ".openbook.db"));
  const results: PhotoResult[] = [];

  // Build query with conditions
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter.scanId) {
    conditions.push("last_scan_id = $scanId");
    params.$scanId = filter.scanId;
  }
  if (filter.person === "all") {
    conditions.push("recognitions IS NOT NULL AND recognitions != '[]'");
  }
  if (filter.after) {
    conditions.push("photo_date >= $after");
    params.$after = filter.after;
  }
  if (filter.before) {
    conditions.push("photo_date <= $before");
    params.$before = filter.before;
  }
  if (filter.file) {
    conditions.push("path LIKE '%' || $file || '%'");
    params.$file = filter.file;
  }

  let query = "SELECT * FROM photos";
  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }
  query += " ORDER BY photo_date ASC, last_scanned_at DESC";

  const rows = db.query(query).all(params as Record<string, string | number>) as Array<{
    hash: string;
    path: string;
    recognitions: string;
    corrections: string | null;
    last_scan_id: number | null;
    last_scanned_at: string;
    photo_date: string | null;
    faces_detected: number | null;
  }>;

  let index = 1;

  for (const row of rows) {
    const recognitions: Recognition[] = row.recognitions ? JSON.parse(row.recognitions) : [];
    const corrections: Correction[] = row.corrections
      ? JSON.parse(row.corrections)
      : [];

    // Use stored photo_date, fallback to extracting from filename
    let photoDate: Date | undefined;
    if (row.photo_date) {
      photoDate = new Date(row.photo_date);
    } else {
      try {
        const filename = basename(row.path);
        photoDate = extractDateFromFilename(filename) ?? statSync(row.path).mtime;
      } catch {
        // File may not exist anymore
      }
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
    if (allRecognitions.length === 0) {
      if (filter.scanId && (!filter.person || filter.person === "all")) {
        results.push({
          index: index++,
          hash: row.hash,
          path: row.path,
          person: "(no match)",
          confidence: 0,
          status: "pending" as PhotoStatus,
          scanId: row.last_scan_id,
          scannedAt: row.last_scanned_at,
          date: photoDate,
          facesDetected: row.faces_detected ?? undefined,
        });
      }
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
        facesDetected: row.faces_detected ?? undefined,
      });

      index++;
    }
  }

  db.close();

  // Sort chronologically before pagination
  results.sort((a, b) => {
    const keyA = extractSortKeyForDisplay(basename(a.path));
    const keyB = extractSortKeyForDisplay(basename(b.path));
    return keyA.localeCompare(keyB);
  });

  // Apply offset and limit
  const total = results.length;
  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? 250;

  return { results: results.slice(offset, offset + limit), total };
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

  writeFileSync(getSessionFilePath(), JSON.stringify(session, null, 2));
}

/**
 * Load last query from session file
 */
function loadLastQuery(): LastQuery | null {
  const sessionPath = getSessionFilePath();
  if (!existsSync(sessionPath)) {
    return null;
  }

  try {
    const content = readFileSync(sessionPath, "utf-8");
    const session = JSON.parse(content) as LastQuery;

    // Check if session is still valid
    const config = loadConfig();
    const timeoutMs = config.session.timeoutMinutes * 60 * 1000;
    const age = Date.now() - session.timestamp;
    if (age > timeoutMs) {
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
  page?: number;
  perPage?: number;
  json?: boolean;
  minConfidence?: number;
  maxConfidence?: number;
  after?: Date;
  before?: Date;
  file?: string;
}

interface PhotosApproveOptions {
  all?: boolean;
  without?: string;
  dryRun?: boolean;
  minConfidence?: number;
  maxConfidence?: number;
  person?: string;
  scan?: number | string;
}

interface PhotosRejectOptions {
  all?: boolean;
  without?: string;
  minConfidence?: number;
  maxConfidence?: number;
  person?: string;
  file?: string;
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
    console.log("Database not initialized. Run 'openbook scan' first.");
    return;
  }

  const config = loadConfig();
  const status = (options.status as PhotoStatus) ?? getDefaultStatus(options);

  // Resolve "latest" to actual scan ID
  let scanId: number | undefined;
  if (options.scan === "latest") {
    const lastScan = getLastScan();
    if (!lastScan) {
      console.log("No scans found. Run 'openbook scan' first.");
      return;
    }
    scanId = lastScan.id;
    console.log(`Using latest scan #${scanId}`);
  } else if (typeof options.scan === "number") {
    scanId = options.scan;
  } else if (typeof options.scan === "string") {
    scanId = parseInt(options.scan, 10);
  }

  // Calculate pagination
  const perPage = options.perPage ?? config.display.pageSize;
  let offset: number;
  let limit: number;

  if (options.page !== undefined) {
    offset = (options.page - 1) * perPage;
    limit = perPage;
  } else {
    offset = options.offset ?? 0;
    limit = options.limit ?? config.display.photoLimit;
  }

  const filter: PhotoFilter = {
    person: options.person,
    status,
    scanId,
    limit,
    offset,
    minConfidence: options.minConfidence,
    maxConfidence: options.maxConfidence,
    after: options.after?.toISOString(),
    before: options.before?.toISOString(),
    file: options.file,
  };

  const { results, total } = queryPhotos(filter);

  // Re-assign indexes (global indexes when paginating)
  results.forEach((photo, i) => {
    photo.index = offset + i + 1;
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
    if (options.page !== undefined) {
      const totalPages = Math.ceil(total / perPage);
      console.log(JSON.stringify({ page: options.page, perPage, totalPages, total, results }, null, 2));
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
    return;
  }

  // Print table
  console.log();
  printPhotoTable(results, config.display.columns);

  console.log();
  if (options.page !== undefined) {
    const totalPages = Math.ceil(total / perPage);
    const startIdx = offset + 1;
    const endIdx = offset + results.length;
    console.log(`Showing ${startIdx}-${endIdx} of ${total} photos (page ${options.page} of ${totalPages}).`);
  } else {
    console.log(`Showing ${results.length} photos.`);
  }

  // Open photos in Preview if requested
  if (options.open && results.length > 0) {
    const paths = [...new Set(results.map((p) => p.path))];
    openPhotosInPreview(paths);
    console.log(`Opened ${paths.length} photos in Preview.`);
  }

  console.log();
  console.log("Commands:");
  console.log("  openbook photos approve <indexes>      Approve by index (1,2,4-6)");
  console.log("  openbook photos approve --all          Approve all shown");
  console.log("  openbook photos reject <indexes>       Reject by index");
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
    console.log("Database not initialized. Run 'openbook scan' first.");
    return;
  }

  // Check if this is person + path format
  if (indexesOrPerson && path) {
    await approveByPersonPath(indexesOrPerson, path, options.dryRun);
    return;
  }

  let toApprove: PhotoResult[];

  // If filters specified, query fresh from database (not limited by cached results)
  const hasFilters = options.person || options.scan || options.minConfidence !== undefined || options.maxConfidence !== undefined;

  if (hasFilters) {
    // Resolve scan ID
    let scanId: number | undefined;
    if (options.scan === "latest") {
      const lastScan = getLastScan();
      if (!lastScan) {
        console.log("No scans found. Run 'openbook scan' first.");
        return;
      }
      scanId = lastScan.id;
      console.log(`Using latest scan #${scanId}`);
    } else if (typeof options.scan === "number") {
      scanId = options.scan;
    } else if (typeof options.scan === "string") {
      scanId = parseInt(options.scan, 10);
    }

    // Query fresh with filters - high limit to get all matching
    const filter: PhotoFilter = {
      person: options.person,
      scanId,
      status: "pending",
      limit: 10000,
      minConfidence: options.minConfidence,
      maxConfidence: options.maxConfidence,
    };
    toApprove = queryPhotos(filter).results;

    // Exclude specified indexes (if any)
    if (options.without) {
      const excludeIndexes = new Set(parseIndexes(options.without));
      toApprove = toApprove.filter((p) => !excludeIndexes.has(p.index));
    }
  } else if (options.all) {
    // Use cached query for --all without filters
    const lastQuery = loadLastQuery();
    if (!lastQuery) {
      console.log("No recent photo list found. Run 'openbook photos' first.");
      return;
    }
    toApprove = [...lastQuery.results];

    // Exclude specified indexes
    if (options.without) {
      const excludeIndexes = new Set(parseIndexes(options.without));
      toApprove = toApprove.filter((p) => !excludeIndexes.has(p.index));
    }
  } else if (indexesOrPerson) {
    // Index-based approval from cached query
    const lastQuery = loadLastQuery();
    if (!lastQuery) {
      console.log("No recent photo list found. Run 'openbook photos' first.");
      return;
    }
    const approveIndexes = new Set(parseIndexes(indexesOrPerson));
    toApprove = lastQuery.results.filter((p) => approveIndexes.has(p.index));
  } else {
    console.log("Please specify indexes, filters, or use --all");
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
    console.error("Photo not found in database. Run 'openbook scan' first.");
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
    console.log("Database not initialized. Run 'openbook scan' first.");
    return;
  }

  // Check if this is person + path format
  if (indexesOrPerson && path) {
    await rejectByPersonPath(indexesOrPerson, path, options.dryRun);
    return;
  }

  // Handle rejection by filename
  if (options.file) {
    await rejectByFilename(options.file, options.dryRun);
    return;
  }

  // Handle standalone confidence-based rejection (without --all)
  if (!options.all && options.maxConfidence !== undefined && !indexesOrPerson && !options.person) {
    await rejectByMaxConfidence(options.maxConfidence, options.person, options.dryRun);
    return;
  }

  let toReject: PhotoResult[];

  // If filters specified, query fresh from database (not limited by cached results)
  const hasFilters = options.person || options.minConfidence !== undefined || options.maxConfidence !== undefined;

  if (hasFilters) {
    // Query fresh with filters - high limit to get all matching
    const filter: PhotoFilter = {
      person: options.person,
      status: "pending",
      limit: 10000,
      minConfidence: options.minConfidence,
      maxConfidence: options.maxConfidence,
    };
    toReject = queryPhotos(filter).results;

    // Exclude specified indexes (if any)
    if (options.without) {
      const excludeIndexes = new Set(parseIndexes(options.without));
      toReject = toReject.filter((p) => !excludeIndexes.has(p.index));
    }
  } else if (options.all) {
    // Use cached query for --all without filters
    const lastQuery = loadLastQuery();
    if (!lastQuery) {
      console.log("No recent photo list found. Run 'openbook photos' first.");
      return;
    }
    toReject = [...lastQuery.results];

    // Exclude specified indexes
    if (options.without) {
      const excludeIndexes = new Set(parseIndexes(options.without));
      toReject = toReject.filter((p) => !excludeIndexes.has(p.index));
    }
  } else if (indexesOrPerson) {
    // Index-based rejection from cached query
    const lastQuery = loadLastQuery();
    if (!lastQuery) {
      console.log("No recent photo list found. Run 'openbook photos' first.");
      return;
    }
    const rejectIndexes = new Set(parseIndexes(indexesOrPerson));
    toReject = lastQuery.results.filter((p) => rejectIndexes.has(p.index));
  } else {
    console.log("Please specify indexes, filters, or use --all");
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
    console.error("Photo not found in database. Run 'openbook scan' first.");
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

  const { results } = queryPhotos(filter);
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
 * Reject a photo by filename from last query results
 */
async function rejectByFilename(filename: string, dryRun?: boolean): Promise<void> {
  const lastQuery = loadLastQuery();
  if (!lastQuery) {
    console.log("No recent photo list found. Run 'openbook photos' first.");
    return;
  }

  // Find photos matching the filename
  const matches = lastQuery.results.filter(
    (p) => basename(p.path) === filename
  );

  if (matches.length === 0) {
    console.error(`No photo matching filename "${filename}" in current results.`);
    process.exit(1);
  }

  if (matches.length > 1) {
    console.error(`Multiple photos match filename "${filename}" (found ${matches.length}). Use index to specify:`);
    for (const photo of matches) {
      console.error(`  [${photo.index}] ${photo.person} (${photo.confidence.toFixed(1)}%) - ${photo.path}`);
    }
    process.exit(1);
  }

  const photo = matches[0];

  if (dryRun) {
    console.log(`[Dry run] Would reject:`);
    console.log(`  [${photo.index}] ${photo.person} (${photo.confidence.toFixed(1)}%) - ${photo.path}`);
    return;
  }

  const person = getPerson(photo.person);
  if (person) {
    const success = addCorrection(photo.hash, person.id, person.name, "false_positive");
    if (success) {
      console.log(`✓ Rejected ${photo.person} (${photo.confidence.toFixed(1)}%) - ${basename(photo.path)}`);
    }
  }
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
    console.log("Database not initialized. Run 'openbook scan' first.");
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
    console.error("Photo not found in database. Run 'openbook scan' first.");
    process.exit(1);
  }

  // Check if person is already in recognitions
  const hasRecognition = photo.recognitions.some((r) => r.personId === person.id);
  if (hasRecognition) {
    console.log(`"${person.name}" is already detected in this photo.`);
    console.log("Use 'openbook photos approve' to confirm the match.");
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
    console.log("Database not initialized. Run 'openbook scan' first.");
    return;
  }

  // Check if osxphotos is installed
  const isInstalled = await checkOsxphotosInstalled();
  if (!isInstalled) {
    console.error("Error: osxphotos is not installed.\n");
    console.error("The 'photos export' command requires osxphotos to create Apple Photos albums.\n");
    console.error("Install osxphotos using one of these methods:\n");
    console.error("  • Using uv:  uv tool install osxphotos");
    console.error("  • Using pip: pip install osxphotos\n");
    console.error("For more information, visit: https://github.com/RhetTbull/osxphotos");
    process.exit(1);
  }

  const config = loadConfig();
  const spinner = ora();

  // Get all approved photos
  const filter: PhotoFilter = {
    person: options.person,
    status: "approved",
    limit: 10000, // Get all approved
  };

  const { results } = queryPhotos(filter);

  if (results.length === 0) {
    console.log("No approved photos to export.");
    if (options.person) {
      console.log(`No approved photos found for "${options.person}".`);
    }
    console.log("Use 'openbook photos approve' to approve photos first.");
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
