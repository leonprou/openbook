import { FaceRecognitionClient } from "../rekognition/client";
import type { FaceMatch, ScanResult } from "../rekognition/types";
import type { PhotoInfo } from "../sources/types";
import { createLogger } from "../logger";
import {
  getPhotoByHash,
  savePhoto,
  saveRecognitionHistory,
  getPerson,
  createPerson,
  type Recognition,
} from "../db";
import { getFileInfo } from "../utils/hash";

const log = createLogger("scanner");

export interface ScanProgress {
  total: number;
  processed: number;
  matched: number;
  newMatched: number;
  cached: number;
  currentPhoto: string;
}

export type ProgressCallback = (progress: ScanProgress) => void;

export interface VerboseInfo {
  path: string;
  fromCache: boolean;
  matches: Array<{ personName: string; confidence: number }>;
}

export type VerboseCallback = (info: VerboseInfo) => void;

export interface PhotoMatch {
  photoPath: string;
  photoHash: string;
  matches: Array<{
    personId: number;
    personName: string;
    confidence: number;
    correctionStatus?: "approved" | "rejected";
  }>;
  fromCache: boolean;
}

export interface ScanStats {
  photosProcessed: number;
  photosCached: number;
  matchesFound: number;
}

/** Result of processing a single photo (before DB writes) */
interface ProcessedPhotoResult {
  photo: PhotoInfo;
  hash: string;
  fileSize: number;
  fromCache: boolean;
  recognitions: Recognition[];
  cachedCorrections: Array<{ personId: number; type: string }>;
}

export class PhotoScanner {
  private client: FaceRecognitionClient;
  private minConfidence: number;

  constructor(client: FaceRecognitionClient, minConfidence: number) {
    this.client = client;
    this.minConfidence = minConfidence;
  }

  /**
   * Scan photos with caching support.
   * Checks database for cached results before calling AWS Rekognition.
   * @param newScansLimit - If set, stops after this many NEW (non-cached) photos are scanned
   * @param onVerbose - If set, called for each photo with detailed info
   */
  async scanPhotosWithCache(
    photos: AsyncGenerator<PhotoInfo>,
    totalCount: number,
    scanId: number,
    onProgress?: ProgressCallback,
    forceRescan: boolean = false,
    newScansLimit?: number,
    onVerbose?: VerboseCallback
  ): Promise<{ personPhotos: Map<string, PhotoMatch[]>; stats: ScanStats }> {
    // Map: personName -> array of PhotoMatch
    const personPhotosMap = new Map<string, PhotoMatch[]>();
    let processed = 0;
    let matched = 0;
    let newMatched = 0;
    let cached = 0;
    let newScans = 0;

    for await (const photo of photos) {
      processed++;
      log.debug({ photo: photo.path, processed, total: totalCount }, "Processing photo");

      if (onProgress) {
        onProgress({
          total: totalCount,
          processed,
          matched,
          newMatched,
          cached,
          currentPhoto: photo.path,
        });
      }

      try {
        // Compute file hash
        const fileInfo = await getFileInfo(photo.path);
        const photoHash = fileInfo.hash;

        // Check cache
        const cachedPhoto = forceRescan ? null : getPhotoByHash(photoHash);
        let recognitions: Recognition[];
        let fromCache = false;

        if (cachedPhoto && cachedPhoto.recognitions.length >= 0) {
          // Use cached recognitions
          recognitions = cachedPhoto.recognitions;
          fromCache = true;
          cached++;
          log.debug({ photo: photo.path, hash: photoHash }, "Using cached result");
        } else {
          // Call AWS Rekognition
          const matches = await this.client.searchFaces(photo.path);
          log.debug({ photo: photo.path, matchCount: matches.length }, "Search completed");

          // Convert matches to recognitions with person IDs
          recognitions = await this.convertMatchesToRecognitions(matches);

          // Save to database
          savePhoto(photoHash, photo.path, fileInfo.size, scanId, recognitions);
          saveRecognitionHistory(photoHash, scanId, recognitions);

          // Track new scans for limit
          newScans++;
        }

        // Apply corrections and filter by confidence
        const effectiveRecognitions = this.applyCorrectionsAndFilter(
          recognitions,
          cachedPhoto?.corrections ?? []
        );

        if (effectiveRecognitions.length > 0) {
          matched++;
          if (!fromCache) {
            newMatched++;
          }

          // Create PhotoMatch entry
          const photoMatch: PhotoMatch = {
            photoPath: photo.path,
            photoHash,
            matches: effectiveRecognitions.map((r) => ({
              personId: r.personId,
              personName: r.personName,
              confidence: r.confidence,
              correctionStatus: this.getCorrectionStatus(
                r.personId,
                cachedPhoto?.corrections ?? []
              ),
            })),
            fromCache,
          };

          // Add to each person's list
          const addedPersons = new Set<string>();
          for (const match of effectiveRecognitions) {
            if (!addedPersons.has(match.personName)) {
              addedPersons.add(match.personName);
              const personMatches = personPhotosMap.get(match.personName) ?? [];
              personMatches.push(photoMatch);
              personPhotosMap.set(match.personName, personMatches);
            }
          }
        }

        // Call verbose callback if provided
        if (onVerbose) {
          onVerbose({
            path: photo.path,
            fromCache,
            matches: effectiveRecognitions.map((r) => ({
              personName: r.personName,
              confidence: r.confidence,
            })),
          });
        }
      } catch (error) {
        log.error({ photo: photo.path, error }, "Error processing photo");
        // Continue on error
      }

      // Stop if we've hit the limit of new (non-cached) scans
      if (newScansLimit && newScans >= newScansLimit) {
        log.debug({ newScans, limit: newScansLimit }, "Reached new scans limit");
        break;
      }
    }

    return {
      personPhotos: personPhotosMap,
      stats: {
        photosProcessed: processed,
        photosCached: cached,
        matchesFound: matched,
      },
    };
  }

  /**
   * Process a single photo: compute hash, check cache, call AWS if needed.
   * Does NOT write to database - that's done after batch completes.
   */
  private async processPhotoItem(
    photo: PhotoInfo,
    forceRescan: boolean
  ): Promise<ProcessedPhotoResult> {
    const fileInfo = await getFileInfo(photo.path);
    const photoHash = fileInfo.hash;

    // Check cache
    const cachedPhoto = forceRescan ? null : getPhotoByHash(photoHash);

    if (cachedPhoto && cachedPhoto.recognitions.length >= 0) {
      // Cache hit
      return {
        photo,
        hash: photoHash,
        fileSize: fileInfo.size,
        fromCache: true,
        recognitions: cachedPhoto.recognitions,
        cachedCorrections: cachedPhoto.corrections,
      };
    }

    // Cache miss - call AWS Rekognition
    const matches = await this.client.searchFaces(photo.path);
    log.debug({ photo: photo.path, matchCount: matches.length }, "Search completed");

    const recognitions = await this.convertMatchesToRecognitions(matches);

    return {
      photo,
      hash: photoHash,
      fileSize: fileInfo.size,
      fromCache: false,
      recognitions,
      cachedCorrections: [],
    };
  }

  /**
   * Scan photos with streaming parallel processing.
   * Feeds photos continuously to Bottleneck - no batch waiting.
   * @param concurrency - Max pending photos (default: 5)
   */
  async scanPhotosParallel(
    photos: AsyncGenerator<PhotoInfo>,
    totalCount: number,
    scanId: number,
    onProgress?: ProgressCallback,
    forceRescan: boolean = false,
    newScansLimit?: number,
    onVerbose?: VerboseCallback,
    concurrency: number = 5
  ): Promise<{ personPhotos: Map<string, PhotoMatch[]>; stats: ScanStats }> {
    const personPhotosMap = new Map<string, PhotoMatch[]>();
    let processed = 0;
    let matched = 0;
    let newMatched = 0;
    let cached = 0;
    let newScans = 0;
    let stopFeeding = false;

    // Track pending promises with their settled state
    const pending: Array<{ promise: Promise<void>; settled: boolean }> = [];

    const handleResult = (result: ProcessedPhotoResult) => {
      processed++;

      if (result.fromCache) {
        cached++;
        log.debug({ photo: result.photo.path, hash: result.hash }, "Using cached result");
      } else {
        // Save to database
        savePhoto(result.hash, result.photo.path, result.fileSize, scanId, result.recognitions);
        saveRecognitionHistory(result.hash, scanId, result.recognitions);
        newScans++;
      }

      // Apply corrections and filter by confidence
      const effectiveRecognitions = this.applyCorrectionsAndFilter(
        result.recognitions,
        result.cachedCorrections
      );

      if (effectiveRecognitions.length > 0) {
        matched++;
        if (!result.fromCache) {
          newMatched++;
        }

        // Create PhotoMatch entry
        const photoMatch: PhotoMatch = {
          photoPath: result.photo.path,
          photoHash: result.hash,
          matches: effectiveRecognitions.map((r) => ({
            personId: r.personId,
            personName: r.personName,
            confidence: r.confidence,
            correctionStatus: this.getCorrectionStatus(r.personId, result.cachedCorrections),
          })),
          fromCache: result.fromCache,
        };

        // Add to each person's list
        const addedPersons = new Set<string>();
        for (const match of effectiveRecognitions) {
          if (!addedPersons.has(match.personName)) {
            addedPersons.add(match.personName);
            const personMatches = personPhotosMap.get(match.personName) ?? [];
            personMatches.push(photoMatch);
            personPhotosMap.set(match.personName, personMatches);
          }
        }
      }

      // Call verbose callback if provided
      if (onVerbose) {
        onVerbose({
          path: result.photo.path,
          fromCache: result.fromCache,
          matches: effectiveRecognitions.map((r) => ({
            personName: r.personName,
            confidence: r.confidence,
          })),
        });
      }

      // Emit progress
      if (onProgress) {
        onProgress({
          total: totalCount,
          processed,
          matched,
          newMatched,
          cached,
          currentPhoto: result.photo.path,
        });
      }

      // Check limit
      if (newScansLimit && newScans >= newScansLimit) {
        log.debug({ newScans, limit: newScansLimit }, "Reached new scans limit");
        stopFeeding = true;
      }
    };

    for await (const photo of photos) {
      if (stopFeeding) break;

      // Start processing immediately - Bottleneck handles rate limiting
      const entry = { promise: Promise.resolve(), settled: false };
      entry.promise = this.processPhotoItem(photo, forceRescan)
        .then(handleResult)
        .catch((error) => {
          log.error({ photo: photo.path, error }, "Error processing photo");
          processed++;
          if (onProgress) {
            onProgress({
              total: totalCount,
              processed,
              matched,
              newMatched,
              cached,
              currentPhoto: photo.path,
            });
          }
        })
        .finally(() => {
          entry.settled = true;
        });

      pending.push(entry);

      // Limit memory: if too many pending, wait for one to complete
      if (pending.length >= concurrency * 2) {
        await Promise.race(pending.map((e) => e.promise));
        // Remove settled promises
        for (let i = pending.length - 1; i >= 0; i--) {
          if (pending[i].settled) {
            pending.splice(i, 1);
          }
        }
      }
    }

    // Wait for remaining
    await Promise.allSettled(pending.map((e) => e.promise));

    return {
      personPhotos: personPhotosMap,
      stats: {
        photosProcessed: processed,
        photosCached: cached,
        matchesFound: matched,
      },
    };
  }

  /**
   * Original scanPhotos method for backwards compatibility.
   * Returns Map<personName, photoPaths[]> without caching.
   */
  async scanPhotos(
    photos: AsyncGenerator<PhotoInfo>,
    totalCount: number,
    onProgress?: ProgressCallback
  ): Promise<Map<string, string[]>> {
    // Map: personName -> Set of photo paths (to avoid duplicates)
    const personPhotosSet = new Map<string, Set<string>>();
    let processed = 0;
    let matched = 0;

    for await (const photo of photos) {
      processed++;
      log.debug({ photo: photo.path, processed, total: totalCount }, "Processing photo");

      if (onProgress) {
        onProgress({
          total: totalCount,
          processed,
          matched,
          newMatched: matched,  // No caching in this method, so newMatched = matched
          cached: 0,
          currentPhoto: photo.path,
        });
      }

      try {
        const matches = await this.client.searchFaces(photo.path);
        log.debug({ photo: photo.path, matchCount: matches.length }, "Search completed");

        if (matches.length > 0) {
          matched++;

          // Track unique persons matched in this photo
          const matchedPersons = new Set<string>();

          // Add photo to each matched person's album (deduplicated)
          for (const match of matches) {
            if (match.confidence >= this.minConfidence && !matchedPersons.has(match.personName)) {
              matchedPersons.add(match.personName);
              log.debug(
                { photo: photo.path, person: match.personName, confidence: match.confidence.toFixed(2) },
                "Face matched"
              );
              const photoSet = personPhotosSet.get(match.personName) ?? new Set();
              photoSet.add(photo.path);
              personPhotosSet.set(match.personName, photoSet);
            }
          }
        }
      } catch (error) {
        log.error({ photo: photo.path, error }, "Error processing photo");
        // Continue on error
      }
    }

    // Convert Sets to arrays for the return value
    const personPhotos = new Map<string, string[]>();
    for (const [person, photoSet] of personPhotosSet) {
      personPhotos.set(person, Array.from(photoSet));
    }

    return personPhotos;
  }

  async scanSinglePhoto(photoPath: string): Promise<ScanResult> {
    const startTime = Date.now();
    const matches = await this.client.searchFaces(photoPath);

    return {
      photoPath,
      matches,
      processingTime: Date.now() - startTime,
    };
  }

  /**
   * Convert AWS FaceMatch objects to Recognition objects with person IDs.
   * Auto-creates person records if they don't exist in the database.
   */
  private async convertMatchesToRecognitions(matches: FaceMatch[]): Promise<Recognition[]> {
    const recognitions: Recognition[] = [];

    for (const match of matches) {
      // Look up person ID from database, or create if not exists
      let person = getPerson(match.personName);
      if (!person) {
        // Auto-create person record for people found in AWS Rekognition
        person = createPerson(match.personName);
        log.debug({ personName: match.personName, personId: person.id }, "Auto-created person record");
      }

      recognitions.push({
        personId: person.id,
        personName: match.personName,
        confidence: match.confidence,
        faceId: match.faceId,
        boundingBox: match.boundingBox,
      });
    }

    return recognitions;
  }

  /**
   * Apply corrections and filter by confidence threshold
   */
  private applyCorrectionsAndFilter(
    recognitions: Recognition[],
    corrections: Array<{ personId: number; type: string }>
  ): Recognition[] {
    const rejectedPersonIds = new Set(
      corrections.filter((c) => c.type === "false_positive").map((c) => c.personId)
    );

    // Filter out rejected and below-threshold recognitions
    const filtered = recognitions.filter(
      (r) => r.confidence >= this.minConfidence && !rejectedPersonIds.has(r.personId)
    );

    // Add false negatives (manually added matches)
    const falseNegatives = corrections
      .filter((c) => c.type === "false_negative")
      .map((c) => {
        const person = getPerson(c.personId.toString());
        return {
          personId: c.personId,
          personName: person?.name ?? `Person ${c.personId}`,
          confidence: 100,
          faceId: "",
          boundingBox: { left: 0, top: 0, width: 0, height: 0 },
        };
      });

    return [...filtered, ...falseNegatives];
  }

  /**
   * Get correction status for a person on this photo
   */
  private getCorrectionStatus(
    personId: number,
    corrections: Array<{ personId: number; type: string }>
  ): "approved" | "rejected" | undefined {
    const correction = corrections.find((c) => c.personId === personId);
    if (!correction) return undefined;
    if (correction.type === "approved") return "approved";
    if (correction.type === "false_positive") return "rejected";
    return undefined;
  }
}
