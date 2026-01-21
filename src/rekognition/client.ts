import {
  RekognitionClient,
  CreateCollectionCommand,
  DeleteCollectionCommand,
  DescribeCollectionCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  ListFacesCommand,
} from "@aws-sdk/client-rekognition";
import Bottleneck from "bottleneck";
import sharp from "sharp";
import { readFileSync } from "fs";
import type {
  IndexedFace,
  FaceMatch,
  CollectionInfo,
  BoundingBox,
} from "./types";
import { createLogger } from "../logger";
import type { Config } from "../config";

const log = createLogger("rekognition");

export class FaceRecognitionClient {
  private client: RekognitionClient;
  private collectionId: string;
  private minConfidence: number;
  private limiter: Bottleneck;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.client = new RekognitionClient({ region: config.aws.region });
    this.collectionId = config.rekognition.collectionId;
    this.minConfidence = config.rekognition.minConfidence;

    this.limiter = new Bottleneck({
      minTime: config.rekognition.rateLimit.minTime,
      maxConcurrent: config.rekognition.rateLimit.maxConcurrent,
    });
  }

  async createCollection(): Promise<void> {
    try {
      await this.client.send(
        new CreateCollectionCommand({
          CollectionId: this.collectionId,
        })
      );
    } catch (error: any) {
      if (error.name === "ResourceAlreadyExistsException") {
        // Collection already exists, that's fine
        return;
      }
      throw error;
    }
  }

  async deleteCollection(): Promise<void> {
    try {
      await this.client.send(
        new DeleteCollectionCommand({
          CollectionId: this.collectionId,
        })
      );
    } catch (error: any) {
      if (error.name === "ResourceNotFoundException") {
        // Collection doesn't exist, that's fine
        return;
      }
      throw error;
    }
  }

  async getCollectionInfo(): Promise<CollectionInfo | null> {
    try {
      const response = await this.client.send(
        new DescribeCollectionCommand({
          CollectionId: this.collectionId,
        })
      );

      return {
        collectionId: this.collectionId,
        faceCount: response.FaceCount ?? 0,
        createdAt: response.CreationTimestamp,
      };
    } catch (error: any) {
      if (error.name === "ResourceNotFoundException") {
        return null;
      }
      throw error;
    }
  }

  async indexFace(
    imagePath: string,
    personName: string
  ): Promise<IndexedFace | null> {
    return this.limiter.schedule(async () => {
      log.debug({ imagePath, personName }, "Indexing face");
      const imageBytes = await this.prepareImage(imagePath);

      const response = await this.client.send(
        new IndexFacesCommand({
          CollectionId: this.collectionId,
          Image: { Bytes: imageBytes },
          ExternalImageId: personName,
          MaxFaces: this.config.rekognition.indexing.maxFaces,
          QualityFilter: this.config.rekognition.indexing.qualityFilter,
          DetectionAttributes: [this.config.rekognition.indexing.detectionAttributes],
        })
      );

      const face = response.FaceRecords?.[0]?.Face;
      if (!face || !face.FaceId) {
        log.debug({ imagePath, personName }, "No face detected in image");
        return null;
      }

      log.debug(
        { imagePath, personName, faceId: face.FaceId, confidence: face.Confidence },
        "Face indexed successfully"
      );

      return {
        faceId: face.FaceId,
        personName,
        imageId: face.ImageId ?? "",
        confidence: face.Confidence ?? 0,
      };
    });
  }

  async searchFaces(imagePath: string): Promise<FaceMatch[]> {
    return this.limiter.schedule(async () => {
      log.debug({ imagePath }, "Searching faces");
      const imageBytes = await this.prepareImage(imagePath);

      try {
        const response = await this.client.send(
          new SearchFacesByImageCommand({
            CollectionId: this.collectionId,
            Image: { Bytes: imageBytes },
            MaxFaces: this.config.rekognition.searching.maxFaces,
            FaceMatchThreshold: this.minConfidence,
          })
        );

        const matches: FaceMatch[] = [];

        for (const match of response.FaceMatches ?? []) {
          if (match.Face && match.Similarity) {
            matches.push({
              personName: match.Face.ExternalImageId ?? "Unknown",
              confidence: match.Similarity,
              faceId: match.Face.FaceId ?? "",
              boundingBox: this.convertBoundingBox(
                response.SearchedFaceBoundingBox
              ),
            });
          }
        }

        // Deduplicate by person, keeping highest confidence per person
        const bestMatches = new Map<string, FaceMatch>();
        for (const match of matches) {
          const existing = bestMatches.get(match.personName);
          if (!existing || match.confidence > existing.confidence) {
            bestMatches.set(match.personName, match);
          }
        }
        const deduplicatedMatches = Array.from(bestMatches.values());

        log.debug(
          { imagePath, matchCount: deduplicatedMatches.length, matches: deduplicatedMatches.map(m => ({ person: m.personName, confidence: m.confidence.toFixed(2) })) },
          "Search completed"
        );

        return deduplicatedMatches;
      } catch (error: any) {
        if (error.name === "InvalidParameterException") {
          log.debug({ imagePath }, "No face detected in image");
          return [];
        }
        log.error({ imagePath, error: error.message }, "Search failed");
        throw error;
      }
    });
  }

  async listFaces(): Promise<Map<string, number>> {
    const personCounts = new Map<string, number>();
    let nextToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListFacesCommand({
          CollectionId: this.collectionId,
          MaxResults: 100,
          NextToken: nextToken,
        })
      );

      for (const face of response.Faces ?? []) {
        const personName = face.ExternalImageId ?? "Unknown";
        personCounts.set(personName, (personCounts.get(personName) ?? 0) + 1);
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return personCounts;
  }

  private async prepareImage(imagePath: string): Promise<Uint8Array> {
    const buffer = readFileSync(imagePath);

    // Resize if too large (Rekognition has 5MB limit)
    const metadata = await sharp(buffer).metadata();
    const { maxDimension, jpegQuality } = this.config.imageProcessing;

    log.debug(
      { imagePath, format: metadata.format, width: metadata.width, height: metadata.height, size: buffer.length },
      "Preparing image"
    );

    if (
      (metadata.width && metadata.width > maxDimension) ||
      (metadata.height && metadata.height > maxDimension)
    ) {
      log.debug({ imagePath }, "Resizing large image");
      return await sharp(buffer)
        .resize(maxDimension, maxDimension, { fit: "inside" })
        .jpeg({ quality: jpegQuality })
        .toBuffer();
    }

    // Convert HEIC to JPEG
    if (
      imagePath.toLowerCase().endsWith(".heic") ||
      metadata.format === "heif"
    ) {
      log.debug({ imagePath }, "Converting HEIC to JPEG");
      return await sharp(buffer).jpeg({ quality: jpegQuality }).toBuffer();
    }

    return buffer;
  }

  private convertBoundingBox(box?: {
    Width?: number;
    Height?: number;
    Left?: number;
    Top?: number;
  }): BoundingBox {
    return {
      width: box?.Width ?? 0,
      height: box?.Height ?? 0,
      left: box?.Left ?? 0,
      top: box?.Top ?? 0,
    };
  }
}
