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

export class FaceRecognitionClient {
  private client: RekognitionClient;
  private collectionId: string;
  private minConfidence: number;
  private limiter: Bottleneck;

  constructor(
    region: string,
    collectionId: string,
    minConfidence: number = 80
  ) {
    this.client = new RekognitionClient({ region });
    this.collectionId = collectionId;
    this.minConfidence = minConfidence;

    // Rate limit: 5 requests per second
    this.limiter = new Bottleneck({
      minTime: 200,
      maxConcurrent: 5,
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
      const imageBytes = await this.prepareImage(imagePath);

      const response = await this.client.send(
        new IndexFacesCommand({
          CollectionId: this.collectionId,
          Image: { Bytes: imageBytes },
          ExternalImageId: personName,
          MaxFaces: 1,
          QualityFilter: "AUTO",
          DetectionAttributes: ["DEFAULT"],
        })
      );

      const face = response.FaceRecords?.[0]?.Face;
      if (!face || !face.FaceId) {
        return null;
      }

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
      const imageBytes = await this.prepareImage(imagePath);

      try {
        const response = await this.client.send(
          new SearchFacesByImageCommand({
            CollectionId: this.collectionId,
            Image: { Bytes: imageBytes },
            MaxFaces: 10,
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

        return matches;
      } catch (error: any) {
        if (error.name === "InvalidParameterException") {
          // No face detected in image
          return [];
        }
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
    const maxDimension = 4096;

    if (
      (metadata.width && metadata.width > maxDimension) ||
      (metadata.height && metadata.height > maxDimension)
    ) {
      return await sharp(buffer)
        .resize(maxDimension, maxDimension, { fit: "inside" })
        .jpeg({ quality: 90 })
        .toBuffer();
    }

    // Convert HEIC to JPEG
    if (
      imagePath.toLowerCase().endsWith(".heic") ||
      metadata.format === "heif"
    ) {
      return await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
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
