import { FaceRecognitionClient } from "../rekognition/client";
import type { FaceMatch, UserMatch, ScanResult, SearchDiagnostics } from "../rekognition/types";
import type { PhotoInfo } from "../sources/types";
import type { Config } from "../config";
import { createLogger } from "../logger";
import {
  getPhotoByHash,
  savePhoto,
  saveRecognitionHistory,
  getPerson,
  createPerson,
  getAllPersons,
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
  diagnostics?: SearchDiagnostics;
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
  facesDetected?: number;
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
  diagnostics?: SearchDiagnostics;
  facesDetected?: number;
}

export class PhotoScanner {
  private client: FaceRecognitionClient;
  private minConfidence: number;
  private searchMethod: "faces" | "users" | "compare";
  private referencePhotos: Map<string, string>;  // personName -> reference photo path

  constructor(client: FaceRecognitionClient, minConfidence: number, searchMethod: "faces" | "users" | "compare" = "faces", referencePhotos?: Map<string, string>) {
    this.client = client;
    this.minConfidence = minConfidence;
    this.searchMethod = searchMethod;
    this.referencePhotos = referencePhotos ?? new Map();
  }

  /**
   * Validate that the training data matches the configured search method.
   * Throws an error if searchMethod is 'users' but persons lack user vectors.
   * Logs an info message if users exist but searchMethod is 'faces'.
   */
  validateSearchMode(): void {
    const persons = getAllPersons();
    this.client.setPersonNames(persons);

    if (this.searchMethod === "users") {
      const missingUsers = persons.filter(p => !p.userId);
      if (missingUsers.length > 0) {
        const names = missingUsers.map(p => p.name).join(", ");
        throw new Error(
          `searchMethod is 'users' but ${missingUsers.length} person(s) lack user vectors: ${names}. ` +
          `Run 'train cleanup --yes && train' to create user vectors.`
        );
      }
    } else if (this.searchMethod === "compare") {
      const missingRefs = persons.filter(p => !p.referencePhotoPath);
      if (missingRefs.length > 0) {
        const names = missingRefs.map(p => p.name).join(", ");
        throw new Error(
          `searchMethod is 'compare' but ${missingRefs.length} person(s) lack reference photos: ${names}. ` +
          `Run 'train' to set reference photos.`
        );
      }
      // Populate referencePhotos map from persons
      for (const person of persons) {
        if (person.referencePhotoPath) {
          this.referencePhotos.set(person.name, person.referencePhotoPath);
        }
      }
    } else {
      // Using 'faces' mode - check if users exist as info
      const withUsers = persons.filter(p => p.userId);
      if (withUsers.length > 0) {
        log.info(
          `${withUsers.length} person(s) have user vectors available. ` +
          `Consider 'searchMethod: users' in config.yaml for potentially better accuracy.`
        );
      }
    }
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
        let diagnostics: SearchDiagnostics | undefined;

        if (cachedPhoto && cachedPhoto.recognitions.length >= 0) {
          // Use cached recognitions
          recognitions = cachedPhoto.recognitions;
          fromCache = true;
          cached++;
          log.debug({ photo: photo.path, hash: photoHash }, "Using cached result");
        } else {
          // Call AWS Rekognition using configured search method
          const result = await this.searchAndConvert(photo.path);
          recognitions = result.recognitions;
          diagnostics = result.diagnostics;
          const facesDetected = diagnostics.faceDetected
            ? 1 + (diagnostics.unsearchedFaceCount ?? 0)
            : 0;

          // Save to database
          savePhoto(photoHash, photo.path, fileInfo.size, scanId, recognitions, photo.photoDate ?? null, facesDetected);
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
          const facesDetected = diagnostics?.faceDetected
            ? 1 + (diagnostics.unsearchedFaceCount ?? 0)
            : diagnostics ? 0 : undefined;
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
            facesDetected,
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
            diagnostics,
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
   * Returns null if limit is reached and photo should be skipped.
   * @param limitState - Optional state for tracking in-flight count against limit
   */
  private async processPhotoItem(
    photo: PhotoInfo,
    forceRescan: boolean,
    limitState?: {
      newScansLimit: number;
      getNewScans: () => number;
      getInFlightNew: () => number;
      incrementInFlight: () => void;
      decrementInFlight: () => void;
    }
  ): Promise<ProcessedPhotoResult | null> {
    const fileInfo = await getFileInfo(photo.path);
    const photoHash = fileInfo.hash;

    // Check cache
    const cachedPhoto = forceRescan ? null : getPhotoByHash(photoHash);

    if (cachedPhoto && cachedPhoto.recognitions.length >= 0) {
      // Cache hit - doesn't count against limit
      return {
        photo,
        hash: photoHash,
        fileSize: fileInfo.size,
        fromCache: true,
        recognitions: cachedPhoto.recognitions,
        cachedCorrections: cachedPhoto.corrections,
      };
    }

    // Cache miss - check limit BEFORE calling AWS
    if (limitState) {
      const { newScansLimit, getNewScans, getInFlightNew, incrementInFlight, decrementInFlight } = limitState;
      if (getNewScans() + getInFlightNew() >= newScansLimit) {
        log.debug({ photo: photo.path }, "Skipping photo - limit reached");
        return null; // Skip this photo
      }

      // Track in-flight and call AWS
      incrementInFlight();
      try {
        const { recognitions, diagnostics } = await this.searchAndConvert(photo.path);
        const facesDetected = diagnostics.faceDetected
          ? 1 + (diagnostics.unsearchedFaceCount ?? 0)
          : 0;

        return {
          photo,
          hash: photoHash,
          fileSize: fileInfo.size,
          fromCache: false,
          recognitions,
          cachedCorrections: [],
          diagnostics,
          facesDetected,
        };
      } finally {
        decrementInFlight();
      }
    }

    // No limit - call AWS directly
    const { recognitions, diagnostics } = await this.searchAndConvert(photo.path);
    const facesDetected = diagnostics.faceDetected
      ? 1 + (diagnostics.unsearchedFaceCount ?? 0)
      : 0;

    return {
      photo,
      hash: photoHash,
      fileSize: fileInfo.size,
      fromCache: false,
      recognitions,
      cachedCorrections: [],
      diagnostics,
      facesDetected,
    };
  }

  /**
   * Search faces or users based on configured search method and convert to recognitions.
   */
  private async searchAndConvert(imagePath: string): Promise<{ recognitions: Recognition[]; diagnostics: SearchDiagnostics }> {
    if (this.searchMethod === "users") {
      const { matches, diagnostics } = await this.client.searchUsers(imagePath);
      log.debug({ imagePath, matchCount: matches.length, method: "users" }, "Search completed");
      return { recognitions: await this.convertUserMatchesToRecognitions(matches), diagnostics };
    } else if (this.searchMethod === "compare") {
      return this.compareAgainstAllPersons(imagePath);
    } else {
      const { matches, diagnostics } = await this.client.searchFaces(imagePath);
      log.debug({ imagePath, matchCount: matches.length, method: "faces" }, "Search completed");
      return { recognitions: await this.convertMatchesToRecognitions(matches), diagnostics };
    }
  }

  /**
   * Compare target image against all persons' reference photos.
   * Each CompareFaces call checks ALL faces in the target image.
   */
  private async compareAgainstAllPersons(imagePath: string): Promise<{ recognitions: Recognition[]; diagnostics: SearchDiagnostics }> {
    const allMatches: FaceMatch[] = [];
    let combinedDiagnostics: SearchDiagnostics = { faceDetected: false };

    for (const [personName, refPath] of this.referencePhotos) {
      const { matches, diagnostics } = await this.client.compareFaces(refPath, imagePath, personName);

      // Merge diagnostics (use the most informative one)
      if (diagnostics.faceDetected) {
        combinedDiagnostics.faceDetected = true;
        if (diagnostics.unsearchedFaceCount !== undefined) {
          combinedDiagnostics.unsearchedFaceCount = Math.max(
            combinedDiagnostics.unsearchedFaceCount ?? 0,
            diagnostics.unsearchedFaceCount
          );
        }
      }

      allMatches.push(...matches);
    }

    log.debug({ imagePath, matchCount: allMatches.length, method: "compare" }, "Compare completed");
    const recognitions = await this.convertCompareMatchesToRecognitions(allMatches);
    return { recognitions, diagnostics: combinedDiagnostics };
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
    let inFlightNew = 0; // Track in-flight AWS calls (cache misses)
    let stopFeeding = false;

    // Track pending promises with their settled state
    const pending: Array<{ promise: Promise<void>; settled: boolean }> = [];

    // Limit state for processPhotoItem
    const limitState = newScansLimit
      ? {
          newScansLimit,
          getNewScans: () => newScans,
          getInFlightNew: () => inFlightNew,
          incrementInFlight: () => { inFlightNew++; },
          decrementInFlight: () => { inFlightNew--; },
        }
      : undefined;

    const handleResult = (result: ProcessedPhotoResult | null) => {
      // Skip if photo was skipped due to limit
      if (result === null) return;

      processed++;

      if (result.fromCache) {
        cached++;
        log.debug({ photo: result.photo.path, hash: result.hash }, "Using cached result");
      } else {
        // Save to database
        savePhoto(result.hash, result.photo.path, result.fileSize, scanId, result.recognitions, result.photo.photoDate ?? null, result.facesDetected ?? null);
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
          facesDetected: result.facesDetected,
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
          diagnostics: result.diagnostics,
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

      // Pre-check: stop if limit already reached (including in-flight)
      if (newScansLimit && newScans + inFlightNew >= newScansLimit) {
        log.debug({ newScans, inFlightNew, limit: newScansLimit }, "Limit reached, stopping feed");
        stopFeeding = true;
        break;
      }

      // Start processing immediately - Bottleneck handles rate limiting
      const entry = { promise: Promise.resolve(), settled: false };
      entry.promise = this.processPhotoItem(photo, forceRescan, limitState)
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
        const { matches } = await this.client.searchFaces(photo.path);
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
    const { matches } = await this.client.searchFaces(photoPath);

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
        searchMethod: "faces",
      });
    }

    return recognitions;
  }

  /**
   * Convert AWS UserMatch objects to Recognition objects with person IDs.
   * Auto-creates person records if they don't exist in the database.
   */
  private async convertUserMatchesToRecognitions(matches: UserMatch[]): Promise<Recognition[]> {
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
        faceId: "", // User matches don't have individual face IDs
        boundingBox: match.boundingBox,
        searchMethod: "users",
      });
    }

    return recognitions;
  }

  /**
   * Convert CompareFaces matches to Recognition objects.
   * Deduplicates by person, keeping highest confidence per person.
   */
  private async convertCompareMatchesToRecognitions(matches: FaceMatch[]): Promise<Recognition[]> {
    // Deduplicate: keep best match per person (multiple faces in target may match same person)
    const bestByPerson = new Map<string, FaceMatch>();
    for (const match of matches) {
      const existing = bestByPerson.get(match.personName);
      if (!existing || match.confidence > existing.confidence) {
        bestByPerson.set(match.personName, match);
      }
    }

    const recognitions: Recognition[] = [];
    for (const match of bestByPerson.values()) {
      let person = getPerson(match.personName);
      if (!person) {
        person = createPerson(match.personName);
        log.debug({ personName: match.personName, personId: person.id }, "Auto-created person record");
      }

      recognitions.push({
        personId: person.id,
        personName: match.personName,
        confidence: match.confidence,
        faceId: "",
        boundingBox: match.boundingBox,
        searchMethod: "compare",
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
