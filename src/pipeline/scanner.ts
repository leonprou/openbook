import { FaceRecognitionClient } from "../rekognition/client";
import type { FaceMatch, ScanResult } from "../rekognition/types";
import type { PhotoInfo } from "../sources/types";

export interface ScanProgress {
  total: number;
  processed: number;
  matched: number;
  currentPhoto: string;
}

export type ProgressCallback = (progress: ScanProgress) => void;

export class PhotoScanner {
  private client: FaceRecognitionClient;
  private minConfidence: number;

  constructor(client: FaceRecognitionClient, minConfidence: number) {
    this.client = client;
    this.minConfidence = minConfidence;
  }

  async scanPhotos(
    photos: AsyncGenerator<PhotoInfo>,
    totalCount: number,
    onProgress?: ProgressCallback
  ): Promise<Map<string, string[]>> {
    // Map: personName -> array of photo paths
    const personPhotos = new Map<string, string[]>();
    let processed = 0;
    let matched = 0;

    for await (const photo of photos) {
      processed++;

      if (onProgress) {
        onProgress({
          total: totalCount,
          processed,
          matched,
          currentPhoto: photo.path,
        });
      }

      try {
        const matches = await this.client.searchFaces(photo.path);

        if (matches.length > 0) {
          matched++;

          // Add photo to each matched person's album
          for (const match of matches) {
            if (match.confidence >= this.minConfidence) {
              const photos = personPhotos.get(match.personName) ?? [];
              photos.push(photo.path);
              personPhotos.set(match.personName, photos);
            }
          }
        }
      } catch (error) {
        // Continue on error
      }
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
}
