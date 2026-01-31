import { Database } from "bun:sqlite";
import { basename, resolve } from "path";
import { getPhotoDateISO } from "../utils/date";

const DB_FILE = ".openbook.db";

export interface Person {
  id: number;
  name: string;
  displayName: string | null;
  notes: string | null;
  trainedAt: string;
  faceCount: number;
  photoCount: number;
  userId: string | null;  // AWS Rekognition User ID for aggregated vectors
  referencePhotoPath: string | null;  // Best reference photo for CompareFaces
}

export interface Scan {
  id: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  sourcePaths: string[];
  photosProcessed: number;
  photosCached: number;
  matchesFound: number;
}

export interface Recognition {
  personId: number;
  personName: string;
  confidence: number;
  faceId: string;
  boundingBox: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  searchMethod?: "faces" | "users" | "compare";  // Track which search method found this match
}

export interface Correction {
  personId: number;
  personName: string;
  type: "approved" | "false_positive" | "false_negative";
  createdAt: string;
}

export interface Photo {
  hash: string;
  path: string;
  fileSize: number | null;
  firstScannedAt: string;
  lastScannedAt: string;
  lastScanId: number | null;
  recognitions: Recognition[];
  corrections: Correction[];
  photoDate: string | null;
}

export interface ScanStats {
  photosProcessed: number;
  photosCached: number;
  matchesFound: number;
}

export interface DbStats {
  totalPhotos: number;
  photosWithMatches: number;
  totalCorrections: number;
  approvedCount: number;
  rejectedCount: number;
  falseNegativeCount: number;
  totalPersons: number;
  lastScan: Scan | null;
}

export interface PersonAccuracyStats {
  personId: number;
  personName: string;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  approvalRate: number | null;
}

export interface ConfidenceBucketStats {
  minConfidence: number;
  maxConfidence: number;
  label: string;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  approvalRate: number | null;
}

export interface SearchMethodStats {
  method: "faces" | "users" | "compare";
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  approvalRate: number | null;
}

export interface AccuracyStats {
  byPerson: PersonAccuracyStats[];
  byConfidence: ConfidenceBucketStats[];
  bySearchMethod: SearchMethodStats[];
  overall: {
    totalDecisions: number;
    approvedCount: number;
    rejectedCount: number;
    approvalRate: number | null;
  };
}

let db: Database | null = null;

function getDb(): Database {
  if (!db) {
    const dbPath = resolve(process.cwd(), DB_FILE);
    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
  }
  return db;
}

export function initDatabase(): void {
  const database = getDb();

  database.exec(`
    -- Known people (created during training)
    CREATE TABLE IF NOT EXISTS persons (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      notes TEXT,
      trained_at TEXT NOT NULL,
      face_count INTEGER DEFAULT 0,
      photo_count INTEGER DEFAULT 0
    );

    -- Track each scan run (for history/audit)
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER,
      source_paths TEXT,
      photos_processed INTEGER DEFAULT 0,
      photos_cached INTEGER DEFAULT 0,
      matches_found INTEGER DEFAULT 0
    );

    -- Main photo records with embedded JSON data
    CREATE TABLE IF NOT EXISTS photos (
      hash TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      file_size INTEGER,
      first_scanned_at TEXT NOT NULL,
      last_scanned_at TEXT NOT NULL,
      last_scan_id INTEGER,
      recognitions TEXT,
      corrections TEXT
    );

    -- Historical record of recognitions (full audit trail)
    CREATE TABLE IF NOT EXISTS recognition_history (
      id INTEGER PRIMARY KEY,
      photo_hash TEXT NOT NULL,
      scan_id INTEGER NOT NULL,
      recognitions TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_photos_last_scan ON photos(last_scan_id);
    CREATE INDEX IF NOT EXISTS idx_history_photo ON recognition_history(photo_hash);
    CREATE INDEX IF NOT EXISTS idx_history_scan ON recognition_history(scan_id);
  `);

  // Migration: add duration_ms column if it doesn't exist
  try {
    database.exec("ALTER TABLE scans ADD COLUMN duration_ms INTEGER");
  } catch {
    // Column already exists, ignore error
  }

  // Migration: add user_id column to persons table
  try {
    database.exec("ALTER TABLE persons ADD COLUMN user_id TEXT");
  } catch {
    // Column already exists, ignore error
  }

  // Migration: add reference_photo_path column to persons table
  try {
    database.exec("ALTER TABLE persons ADD COLUMN reference_photo_path TEXT");
  } catch {
    // Column already exists, ignore error
  }

  // Migration: add photo_date column to photos table
  try {
    database.exec("ALTER TABLE photos ADD COLUMN photo_date TEXT");
  } catch {
    // Column already exists, ignore error
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_photos_photo_date ON photos(photo_date)");

  // Migration: add faces_detected column to photos table
  try {
    database.exec("ALTER TABLE photos ADD COLUMN faces_detected INTEGER");
  } catch {
    // Column already exists, ignore error
  }

  // Directory cache for fast scan skipping
  database.exec(`
    CREATE TABLE IF NOT EXISTS directories (
      path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      file_count INTEGER NOT NULL,
      last_scan_id INTEGER,
      scanned_at TEXT NOT NULL
    );
  `);

  // Clear incorrectly parsed dates (e.g. 1900-xx-xx from bad regex matches)
  database.exec("UPDATE photos SET photo_date = NULL WHERE photo_date LIKE '1900-%'");

  // Backfill photo_date for existing records
  const nullDateRows = database.query(
    "SELECT hash, path FROM photos WHERE photo_date IS NULL"
  ).all() as Array<{ hash: string; path: string }>;

  if (nullDateRows.length > 0) {
    const updateStmt = database.prepare(
      "UPDATE photos SET photo_date = $photoDate WHERE hash = $hash"
    );

    database.exec("BEGIN");
    for (const row of nullDateRows) {
      const photoDate = getPhotoDateISO(row.path, basename(row.path));
      if (photoDate) {
        updateStmt.run({ $photoDate: photoDate, $hash: row.hash });
      }
    }
    database.exec("COMMIT");
  }
}

// Person functions
export function createPerson(name: string): Person {
  const database = getDb();
  const now = new Date().toISOString();

  const stmt = database.query(`
    INSERT INTO persons (name, trained_at)
    VALUES ($name, $now)
    ON CONFLICT(name) DO UPDATE SET trained_at = excluded.trained_at
    RETURNING *
  `);

  const row = stmt.get({ $name: name, $now: now }) as {
    id: number;
    name: string;
    display_name: string | null;
    notes: string | null;
    trained_at: string;
    face_count: number;
    photo_count: number;
    user_id: string | null;
    reference_photo_path: string | null;
  };

  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    notes: row.notes,
    trainedAt: row.trained_at,
    faceCount: row.face_count,
    photoCount: row.photo_count,
    userId: row.user_id,
    referencePhotoPath: row.reference_photo_path,
  };
}

export function getPerson(name: string): Person | null {
  const database = getDb();
  const stmt = database.query("SELECT * FROM persons WHERE name = $name");
  const row = stmt.get({ $name: name }) as {
    id: number;
    name: string;
    display_name: string | null;
    notes: string | null;
    trained_at: string;
    face_count: number;
    photo_count: number;
    user_id: string | null;
    reference_photo_path: string | null;
  } | null;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    notes: row.notes,
    trainedAt: row.trained_at,
    faceCount: row.face_count,
    photoCount: row.photo_count,
    userId: row.user_id,
    referencePhotoPath: row.reference_photo_path,
  };
}

export function getPersonById(id: number): Person | null {
  const database = getDb();
  const stmt = database.query("SELECT * FROM persons WHERE id = $id");
  const row = stmt.get({ $id: id }) as {
    id: number;
    name: string;
    display_name: string | null;
    notes: string | null;
    trained_at: string;
    face_count: number;
    photo_count: number;
    user_id: string | null;
    reference_photo_path: string | null;
  } | null;

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    notes: row.notes,
    trainedAt: row.trained_at,
    faceCount: row.face_count,
    photoCount: row.photo_count,
    userId: row.user_id,
    referencePhotoPath: row.reference_photo_path,
  };
}

export function getAllPersons(): Person[] {
  const database = getDb();
  const stmt = database.query("SELECT * FROM persons ORDER BY name");
  const rows = stmt.all() as Array<{
    id: number;
    name: string;
    display_name: string | null;
    notes: string | null;
    trained_at: string;
    face_count: number;
    photo_count: number;
    user_id: string | null;
    reference_photo_path: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    notes: row.notes,
    trainedAt: row.trained_at,
    faceCount: row.face_count,
    photoCount: row.photo_count,
    userId: row.user_id,
    referencePhotoPath: row.reference_photo_path,
  }));
}

export function updatePersonFaceCount(personId: number, faceCount: number): void {
  const database = getDb();
  const stmt = database.query("UPDATE persons SET face_count = $faceCount WHERE id = $id");
  stmt.run({ $faceCount: faceCount, $id: personId });
}

export function updatePersonPhotoCount(personId: number, photoCount: number): void {
  const database = getDb();
  const stmt = database.query("UPDATE persons SET photo_count = $photoCount WHERE id = $id");
  stmt.run({ $photoCount: photoCount, $id: personId });
}

export function updatePersonUserId(personId: number, userId: string | null): void {
  const database = getDb();
  const stmt = database.query("UPDATE persons SET user_id = $userId WHERE id = $id");
  stmt.run({ $userId: userId, $id: personId });
}

export function updatePersonReferencePhoto(personId: number, path: string | null): void {
  const database = getDb();
  const stmt = database.query("UPDATE persons SET reference_photo_path = $path WHERE id = $id");
  stmt.run({ $path: path, $id: personId });
}

// Scan functions
export function createScan(sourcePaths: string[]): number {
  const database = getDb();
  const now = new Date().toISOString();
  const stmt = database.query(`
    INSERT INTO scans (started_at, source_paths)
    VALUES ($now, $paths)
  `);
  stmt.run({ $now: now, $paths: JSON.stringify(sourcePaths) });

  // Get last insert rowid
  const result = database.query("SELECT last_insert_rowid() as id").get() as { id: number };
  return result.id;
}

export function completeScan(scanId: number, stats: ScanStats): number {
  const database = getDb();
  const now = new Date();

  // Get the scan's started_at to calculate duration
  const scanRow = database.query("SELECT started_at FROM scans WHERE id = $id").get({ $id: scanId }) as { started_at: string } | null;
  const durationMs = scanRow ? now.getTime() - new Date(scanRow.started_at).getTime() : null;

  const stmt = database.query(`
    UPDATE scans
    SET completed_at = $now,
        duration_ms = $durationMs,
        photos_processed = $processed,
        photos_cached = $cached,
        matches_found = $matches
    WHERE id = $id
  `);
  stmt.run({
    $now: now.toISOString(),
    $durationMs: durationMs,
    $processed: stats.photosProcessed,
    $cached: stats.photosCached,
    $matches: stats.matchesFound,
    $id: scanId,
  });

  return durationMs ?? 0;
}

export function getLastScan(): Scan | null {
  const database = getDb();
  const stmt = database.query(`
    SELECT * FROM scans
    ORDER BY id DESC
    LIMIT 1
  `);
  const row = stmt.get() as {
    id: number;
    started_at: string;
    completed_at: string | null;
    duration_ms: number | null;
    source_paths: string | null;
    photos_processed: number;
    photos_cached: number;
    matches_found: number;
  } | null;

  if (!row) return null;

  return {
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    sourcePaths: row.source_paths ? JSON.parse(row.source_paths) : [],
    photosProcessed: row.photos_processed,
    photosCached: row.photos_cached,
    matchesFound: row.matches_found,
  };
}

export function getScanById(scanId: number): Scan | null {
  const database = getDb();
  const stmt = database.query(`
    SELECT * FROM scans
    WHERE id = $scanId
  `);
  const row = stmt.get({ $scanId: scanId }) as {
    id: number;
    started_at: string;
    completed_at: string | null;
    duration_ms: number | null;
    source_paths: string | null;
    photos_processed: number;
    photos_cached: number;
    matches_found: number;
  } | null;

  if (!row) return null;

  return {
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    sourcePaths: row.source_paths ? JSON.parse(row.source_paths) : [],
    photosProcessed: row.photos_processed,
    photosCached: row.photos_cached,
    matchesFound: row.matches_found,
  };
}

export function getRecentScans(limit: number = 5): Scan[] {
  const database = getDb();
  const stmt = database.query(`
    SELECT * FROM scans
    ORDER BY id DESC
    LIMIT $limit
  `);
  const rows = stmt.all({ $limit: limit }) as Array<{
    id: number;
    started_at: string;
    completed_at: string | null;
    duration_ms: number | null;
    source_paths: string | null;
    photos_processed: number;
    photos_cached: number;
    matches_found: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    sourcePaths: row.source_paths ? JSON.parse(row.source_paths) : [],
    photosProcessed: row.photos_processed,
    photosCached: row.photos_cached,
    matchesFound: row.matches_found,
  }));
}

// Clear all scans and reset photos
export function clearAllScans(): { scansCleared: number; photosReset: number } {
  const database = getDb();

  const scansCount = (
    database.query("SELECT COUNT(*) as count FROM scans").get() as { count: number }
  ).count;
  const photosCount = (
    database.query("SELECT COUNT(*) as count FROM photos").get() as { count: number }
  ).count;

  database.exec("DELETE FROM recognition_history");
  database.exec("DELETE FROM scans");
  database.exec("DELETE FROM directories");
  database.exec("UPDATE photos SET recognitions = NULL, corrections = NULL, last_scan_id = NULL");

  return { scansCleared: scansCount, photosReset: photosCount };
}

// Directory cache functions
export function getDirectoryCache(dirPath: string): { mtimeMs: number; fileCount: number } | null {
  const database = getDb();
  const row = database.query("SELECT mtime_ms, file_count FROM directories WHERE path = $path")
    .get({ $path: dirPath }) as { mtime_ms: number; file_count: number } | null;
  if (!row) return null;
  return { mtimeMs: row.mtime_ms, fileCount: row.file_count };
}

export function saveDirectoryCache(dirPath: string, mtimeMs: number, fileCount: number, scanId: number): void {
  const database = getDb();
  database.query(`
    INSERT OR REPLACE INTO directories (path, mtime_ms, file_count, last_scan_id, scanned_at)
    VALUES ($path, $mtimeMs, $fileCount, $scanId, $scannedAt)
  `).run({
    $path: dirPath,
    $mtimeMs: mtimeMs,
    $fileCount: fileCount,
    $scanId: scanId,
    $scannedAt: new Date().toISOString(),
  });
}

export function clearDirectoryCaches(): number {
  const database = getDb();
  const count = (
    database.query("SELECT COUNT(*) as count FROM directories").get() as { count: number }
  ).count;
  database.exec("DELETE FROM directories");
  return count;
}

export function removeDirectoryCache(pathPrefix: string): number {
  const database = getDb();
  const result = database.query(
    "DELETE FROM directories WHERE path = $path OR path LIKE $prefix"
  ).run({ $path: pathPrefix, $prefix: pathPrefix + "/%" });
  return result.changes;
}

export function getDirectoryCacheStats(): { directories: number; files: number } {
  const database = getDb();
  const row = database.query(
    "SELECT COUNT(*) as dirs, COALESCE(SUM(file_count), 0) as files FROM directories"
  ).get() as { dirs: number; files: number };
  return { directories: row.dirs, files: row.files };
}

// Clear all photos (keeps training data in persons table)
export function clearAllPhotos(): { photosCleared: number; scansCleared: number } {
  const database = getDb();

  const photosCount = (
    database.query("SELECT COUNT(*) as count FROM photos").get() as { count: number }
  ).count;
  const scansCount = (
    database.query("SELECT COUNT(*) as count FROM scans").get() as { count: number }
  ).count;

  database.exec("DELETE FROM recognition_history");
  database.exec("DELETE FROM scans");
  database.exec("DELETE FROM photos");
  database.exec("DELETE FROM directories");

  // Reset photo counts on persons (but keep training data)
  database.exec("UPDATE persons SET photo_count = 0");

  return { photosCleared: photosCount, scansCleared: scansCount };
}

// Photo functions
export function getPhotoByHash(hash: string): Photo | null {
  const database = getDb();
  const stmt = database.query("SELECT * FROM photos WHERE hash = $hash");
  const row = stmt.get({ $hash: hash }) as {
    hash: string;
    path: string;
    file_size: number | null;
    first_scanned_at: string;
    last_scanned_at: string;
    last_scan_id: number | null;
    recognitions: string | null;
    corrections: string | null;
    photo_date: string | null;
  } | null;

  if (!row) return null;

  return {
    hash: row.hash,
    path: row.path,
    fileSize: row.file_size,
    firstScannedAt: row.first_scanned_at,
    lastScannedAt: row.last_scanned_at,
    lastScanId: row.last_scan_id,
    recognitions: row.recognitions ? JSON.parse(row.recognitions) : [],
    corrections: row.corrections ? JSON.parse(row.corrections) : [],
    photoDate: row.photo_date,
  };
}

export function savePhoto(
  hash: string,
  path: string,
  fileSize: number | null,
  scanId: number,
  recognitions: Recognition[],
  photoDate: string | null = null,
  facesDetected: number | null = null
): void {
  const database = getDb();
  const now = new Date().toISOString();

  const stmt = database.query(`
    INSERT INTO photos (hash, path, file_size, first_scanned_at, last_scanned_at, last_scan_id, recognitions, corrections, photo_date, faces_detected)
    VALUES ($hash, $path, $fileSize, $now, $now, $scanId, $recognitions, '[]', $photoDate, $facesDetected)
    ON CONFLICT(hash) DO UPDATE SET
      path = excluded.path,
      file_size = excluded.file_size,
      last_scanned_at = excluded.last_scanned_at,
      last_scan_id = excluded.last_scan_id,
      recognitions = excluded.recognitions,
      photo_date = COALESCE(photos.photo_date, excluded.photo_date),
      faces_detected = excluded.faces_detected
  `);

  stmt.run({
    $hash: hash,
    $path: path,
    $fileSize: fileSize,
    $now: now,
    $scanId: scanId,
    $recognitions: JSON.stringify(recognitions),
    $photoDate: photoDate,
    $facesDetected: facesDetected,
  });
}

export function saveRecognitionHistory(
  photoHash: string,
  scanId: number,
  recognitions: Recognition[]
): void {
  const database = getDb();
  const now = new Date().toISOString();

  const stmt = database.query(`
    INSERT INTO recognition_history (photo_hash, scan_id, recognitions, created_at)
    VALUES ($photoHash, $scanId, $recognitions, $now)
  `);

  stmt.run({
    $photoHash: photoHash,
    $scanId: scanId,
    $recognitions: JSON.stringify(recognitions),
    $now: now,
  });
}

export function getPhotosByScan(scanId: number): Photo[] {
  const database = getDb();
  const stmt = database.query(`
    SELECT * FROM photos
    WHERE last_scan_id = $scanId
    ORDER BY path
  `);
  const rows = stmt.all({ $scanId: scanId }) as Array<{
    hash: string;
    path: string;
    file_size: number | null;
    first_scanned_at: string;
    last_scanned_at: string;
    last_scan_id: number | null;
    recognitions: string | null;
    corrections: string | null;
    photo_date: string | null;
  }>;

  return rows.map((row) => ({
    hash: row.hash,
    path: row.path,
    fileSize: row.file_size,
    firstScannedAt: row.first_scanned_at,
    lastScannedAt: row.last_scanned_at,
    lastScanId: row.last_scan_id,
    recognitions: row.recognitions ? JSON.parse(row.recognitions) : [],
    corrections: row.corrections ? JSON.parse(row.corrections) : [],
    photoDate: row.photo_date,
  }));
}

// Correction functions
export function addCorrection(
  photoHash: string,
  personId: number,
  personName: string,
  type: "approved" | "false_positive" | "false_negative"
): boolean {
  const database = getDb();
  const photo = getPhotoByHash(photoHash);

  if (!photo) return false;

  const now = new Date().toISOString();
  const corrections = photo.corrections.filter(
    (c) => c.personId !== personId
  );
  corrections.push({ personId, personName, type, createdAt: now });

  const stmt = database.query("UPDATE photos SET corrections = $corrections WHERE hash = $hash");
  stmt.run({ $corrections: JSON.stringify(corrections), $hash: photoHash });

  return true;
}

export function getEffectiveMatches(photoHash: string): Recognition[] {
  const photo = getPhotoByHash(photoHash);
  if (!photo) return [];

  const corrections = new Map(
    photo.corrections.map((c) => [c.personId, c.type])
  );

  // Filter out false positives
  const filtered = photo.recognitions.filter((r) => {
    const correction = corrections.get(r.personId);
    return correction !== "false_positive";
  });

  // Add false negatives (manually added matches)
  const falseNegatives = photo.corrections
    .filter((c) => c.type === "false_negative")
    .map((c) => ({
      personId: c.personId,
      personName: c.personName,
      confidence: 100, // Manual match = 100% confidence
      faceId: "",
      boundingBox: { left: 0, top: 0, width: 0, height: 0 },
    }));

  return [...filtered, ...falseNegatives];
}

// Stats functions
export function getStats(): DbStats {
  const database = getDb();

  const totalPhotos = (
    database.query("SELECT COUNT(*) as count FROM photos").get() as { count: number }
  ).count;

  const photosWithMatches = (
    database.query(
      "SELECT COUNT(*) as count FROM photos WHERE recognitions != '[]' AND recognitions IS NOT NULL"
    ).get() as { count: number }
  ).count;

  const totalPersons = (
    database.query("SELECT COUNT(*) as count FROM persons").get() as { count: number }
  ).count;

  // Count corrections by type
  const allPhotos = database.query("SELECT corrections FROM photos WHERE corrections IS NOT NULL").all() as Array<{ corrections: string }>;
  let approvedCount = 0;
  let rejectedCount = 0;
  let falseNegativeCount = 0;

  for (const row of allPhotos) {
    const corrections: Correction[] = JSON.parse(row.corrections);
    for (const c of corrections) {
      if (c.type === "approved") approvedCount++;
      else if (c.type === "false_positive") rejectedCount++;
      else if (c.type === "false_negative") falseNegativeCount++;
    }
  }

  const totalCorrections = approvedCount + rejectedCount + falseNegativeCount;
  const lastScan = getLastScan();

  return {
    totalPhotos,
    photosWithMatches,
    totalCorrections,
    approvedCount,
    rejectedCount,
    falseNegativeCount,
    totalPersons,
    lastScan,
  };
}

// Get accuracy stats for evaluating classification correctness
export function getAccuracyStats(): AccuracyStats {
  const database = getDb();

  // Query all photos with recognitions
  const rows = database.query(
    "SELECT recognitions, corrections FROM photos WHERE recognitions IS NOT NULL AND recognitions != '[]'"
  ).all() as Array<{ recognitions: string; corrections: string | null }>;

  // Initialize buckets: 50-60, 60-70, 70-80, 80-90, 90-100
  const buckets = [
    { min: 50, max: 60, label: "50-60%" },
    { min: 60, max: 70, label: "60-70%" },
    { min: 70, max: 80, label: "70-80%" },
    { min: 80, max: 90, label: "80-90%" },
    { min: 90, max: 100, label: "90-100%" },
  ];

  // Initialize tracking maps
  const personStats = new Map<number, { name: string; approved: number; rejected: number; pending: number }>();
  const bucketStats = buckets.map(b => ({
    ...b,
    approved: 0,
    rejected: 0,
    pending: 0,
  }));

  // Initialize search method stats
  const methodStats = new Map<"faces" | "users" | "compare", { approved: number; rejected: number; pending: number }>([
    ["faces", { approved: 0, rejected: 0, pending: 0 }],
    ["users", { approved: 0, rejected: 0, pending: 0 }],
    ["compare", { approved: 0, rejected: 0, pending: 0 }],
  ]);

  // Process each photo
  for (const row of rows) {
    const recognitions: Recognition[] = JSON.parse(row.recognitions);
    const corrections: Correction[] = row.corrections ? JSON.parse(row.corrections) : [];

    // Build correction lookup by personId
    const correctionMap = new Map<number, "approved" | "false_positive">();
    for (const c of corrections) {
      if (c.type === "approved" || c.type === "false_positive") {
        correctionMap.set(c.personId, c.type);
      }
    }

    // Process each recognition
    for (const rec of recognitions) {
      const correction = correctionMap.get(rec.personId);
      const status = correction === "approved" ? "approved"
        : correction === "false_positive" ? "rejected"
        : "pending";

      // Update person stats
      let ps = personStats.get(rec.personId);
      if (!ps) {
        ps = { name: rec.personName, approved: 0, rejected: 0, pending: 0 };
        personStats.set(rec.personId, ps);
      }
      ps[status]++;

      // Update confidence bucket stats
      const bucket = bucketStats.find(b => rec.confidence >= b.min && rec.confidence < b.max)
        || bucketStats[bucketStats.length - 1]; // 100% goes in last bucket
      bucket[status]++;

      // Update search method stats (default to 'faces' for pre-existing recognitions)
      const searchMethod = rec.searchMethod ?? "faces";
      const ms = methodStats.get(searchMethod)!;
      ms[status]++;
    }
  }

  // Convert person stats to array
  const byPerson: PersonAccuracyStats[] = Array.from(personStats.entries())
    .map(([personId, stats]) => {
      const total = stats.approved + stats.rejected;
      return {
        personId,
        personName: stats.name,
        approvedCount: stats.approved,
        rejectedCount: stats.rejected,
        pendingCount: stats.pending,
        approvalRate: total > 0 ? (stats.approved / total) * 100 : null,
      };
    })
    .sort((a, b) => a.personName.localeCompare(b.personName));

  // Convert bucket stats to final format
  const byConfidence: ConfidenceBucketStats[] = bucketStats.map(b => {
    const total = b.approved + b.rejected;
    return {
      minConfidence: b.min,
      maxConfidence: b.max,
      label: b.label,
      approvedCount: b.approved,
      rejectedCount: b.rejected,
      pendingCount: b.pending,
      approvalRate: total > 0 ? (b.approved / total) * 100 : null,
    };
  }).reverse(); // Show highest confidence first

  // Convert method stats to final format (only include methods with data)
  const bySearchMethod: SearchMethodStats[] = Array.from(methodStats.entries())
    .filter(([_, stats]) => stats.approved + stats.rejected + stats.pending > 0)
    .map(([method, stats]) => {
      const total = stats.approved + stats.rejected;
      return {
        method,
        approvedCount: stats.approved,
        rejectedCount: stats.rejected,
        pendingCount: stats.pending,
        approvalRate: total > 0 ? (stats.approved / total) * 100 : null,
      };
    });

  // Calculate overall stats
  const totalApproved = byPerson.reduce((sum, p) => sum + p.approvedCount, 0);
  const totalRejected = byPerson.reduce((sum, p) => sum + p.rejectedCount, 0);
  const totalDecisions = totalApproved + totalRejected;

  return {
    byPerson,
    byConfidence,
    bySearchMethod,
    overall: {
      totalDecisions,
      approvedCount: totalApproved,
      rejectedCount: totalRejected,
      approvalRate: totalDecisions > 0 ? (totalApproved / totalDecisions) * 100 : null,
    },
  };
}

// Get photo counts per person from current photo data
export function getPhotoCountsByPerson(): Map<number, number> {
  const database = getDb();
  const rows = database.query(
    "SELECT recognitions, corrections FROM photos WHERE recognitions IS NOT NULL"
  ).all() as Array<{ recognitions: string; corrections: string | null }>;

  const counts = new Map<number, number>();

  for (const row of rows) {
    const recognitions: Recognition[] = JSON.parse(row.recognitions);
    const corrections: Correction[] = row.corrections ? JSON.parse(row.corrections) : [];

    const rejectedPersonIds = new Set(
      corrections.filter((c) => c.type === "false_positive").map((c) => c.personId)
    );

    const falseNegativePersonIds = corrections
      .filter((c) => c.type === "false_negative")
      .map((c) => c.personId);

    // Count non-rejected recognitions
    for (const r of recognitions) {
      if (!rejectedPersonIds.has(r.personId)) {
        counts.set(r.personId, (counts.get(r.personId) ?? 0) + 1);
      }
    }

    // Count false negatives
    for (const personId of falseNegativePersonIds) {
      counts.set(personId, (counts.get(personId) ?? 0) + 1);
    }
  }

  return counts;
}

// Update all person photo counts based on current data
export function updateAllPersonPhotoCounts(): void {
  const counts = getPhotoCountsByPerson();
  const persons = getAllPersons();

  for (const person of persons) {
    const count = counts.get(person.id) ?? 0;
    updatePersonPhotoCount(person.id, count);
  }
}

// Person confidence stats (min/avg/max of recognition confidence)
export interface PersonConfidenceStats {
  min: number;
  avg: number;
  max: number;
  count: number;
}

export function getPersonConfidenceStats(personName: string): PersonConfidenceStats | null {
  const database = getDb();
  const rows = database.query(
    "SELECT recognitions FROM photos WHERE recognitions IS NOT NULL AND recognitions != '[]'"
  ).all() as Array<{ recognitions: string }>;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;

  for (const row of rows) {
    const recognitions: Recognition[] = JSON.parse(row.recognitions);
    for (const rec of recognitions) {
      if (rec.personName === personName) {
        if (rec.confidence < min) min = rec.confidence;
        if (rec.confidence > max) max = rec.confidence;
        sum += rec.confidence;
        count++;
      }
    }
  }

  if (count === 0) return null;
  return { min, avg: sum / count, max, count };
}

// Recent matches for a person (most recently scanned photos)
export interface PersonRecentMatch {
  path: string;
  confidence: number;
  scannedAt: string;
  status: "pending" | "approved" | "rejected" | "manual";
}

export function getRecentMatchesForPerson(personName: string, limit: number = 5): PersonRecentMatch[] {
  const database = getDb();
  const rows = database.query(
    "SELECT path, recognitions, corrections, last_scanned_at FROM photos WHERE recognitions IS NOT NULL AND recognitions != '[]' ORDER BY last_scanned_at DESC"
  ).all() as Array<{
    path: string;
    recognitions: string;
    corrections: string | null;
    last_scanned_at: string;
  }>;

  const results: PersonRecentMatch[] = [];

  for (const row of rows) {
    if (results.length >= limit) break;

    const recognitions: Recognition[] = JSON.parse(row.recognitions);
    const corrections: Correction[] = row.corrections ? JSON.parse(row.corrections) : [];

    const rec = recognitions.find(r => r.personName === personName);
    if (!rec) continue;

    const correction = corrections.find(c => c.personId === rec.personId);
    let status: PersonRecentMatch["status"] = "pending";
    if (correction) {
      if (correction.type === "approved") status = "approved";
      else if (correction.type === "false_positive") status = "rejected";
      else if (correction.type === "false_negative") status = "manual";
    }

    results.push({
      path: row.path,
      confidence: rec.confidence,
      scannedAt: row.last_scanned_at,
      status,
    });
  }

  return results;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
