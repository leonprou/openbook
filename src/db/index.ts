import { Database } from "bun:sqlite";
import { resolve } from "path";

const DB_FILE = ".claude-book.db";

export interface Person {
  id: number;
  name: string;
  displayName: string | null;
  notes: string | null;
  trainedAt: string;
  faceCount: number;
  photoCount: number;
}

export interface Scan {
  id: number;
  startedAt: string;
  completedAt: string | null;
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
  };

  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    notes: row.notes,
    trainedAt: row.trained_at,
    faceCount: row.face_count,
    photoCount: row.photo_count,
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
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    notes: row.notes,
    trainedAt: row.trained_at,
    faceCount: row.face_count,
    photoCount: row.photo_count,
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

export function completeScan(scanId: number, stats: ScanStats): void {
  const database = getDb();
  const now = new Date().toISOString();
  const stmt = database.query(`
    UPDATE scans
    SET completed_at = $now,
        photos_processed = $processed,
        photos_cached = $cached,
        matches_found = $matches
    WHERE id = $id
  `);
  stmt.run({
    $now: now,
    $processed: stats.photosProcessed,
    $cached: stats.photosCached,
    $matches: stats.matchesFound,
    $id: scanId,
  });
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
    source_paths: string | null;
    photos_processed: number;
    photos_cached: number;
    matches_found: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
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
  database.exec("UPDATE photos SET recognitions = NULL, corrections = NULL, last_scan_id = NULL");

  return { scansCleared: scansCount, photosReset: photosCount };
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
  };
}

export function savePhoto(
  hash: string,
  path: string,
  fileSize: number | null,
  scanId: number,
  recognitions: Recognition[]
): void {
  const database = getDb();
  const now = new Date().toISOString();

  const stmt = database.query(`
    INSERT INTO photos (hash, path, file_size, first_scanned_at, last_scanned_at, last_scan_id, recognitions, corrections)
    VALUES ($hash, $path, $fileSize, $now, $now, $scanId, $recognitions, '[]')
    ON CONFLICT(hash) DO UPDATE SET
      path = excluded.path,
      file_size = excluded.file_size,
      last_scanned_at = excluded.last_scanned_at,
      last_scan_id = excluded.last_scan_id,
      recognitions = excluded.recognitions
  `);

  stmt.run({
    $hash: hash,
    $path: path,
    $fileSize: fileSize,
    $now: now,
    $scanId: scanId,
    $recognitions: JSON.stringify(recognitions),
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

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
