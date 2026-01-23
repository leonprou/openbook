import {
  RekognitionClient,
  CreateCollectionCommand,
  DeleteCollectionCommand,
  DescribeCollectionCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  SearchUsersByImageCommand,
  ListFacesCommand,
  ListUsersCommand,
  CreateUserCommand,
  DeleteUserCommand,
  AssociateFacesCommand,
} from "@aws-sdk/client-rekognition";
import Bottleneck from "bottleneck";
import sharp from "sharp";
import { readFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import type {
  IndexedFace,
  FaceMatch,
  UserMatch,
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
  private userIdToName: Map<string, string> = new Map();

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

  /**
   * Set canonical person names for userId resolution.
   * Maps userId (e.g., "user_ada") to the correct display name (e.g., "Ada").
   */
  setPersonNames(persons: Array<{ name: string }>): void {
    this.userIdToName.clear();
    for (const person of persons) {
      const userId = `user_${person.name.toLowerCase().replace(/\s+/g, "_")}`;
      this.userIdToName.set(userId, person.name);
    }
  }

  private resolvePersonName(userId: string): string {
    return this.userIdToName.get(userId)
      ?? (userId.startsWith("user_") ? userId.slice(5).replace(/_/g, " ") : userId);
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
        userCount: response.UserCount ?? 0,
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

  /**
   * Create a user in the collection for aggregated face matching.
   * User ID format: user_{personname} (lowercase, spaces to underscores)
   */
  async createUser(personName: string): Promise<string> {
    const userId = `user_${personName.toLowerCase().replace(/\s+/g, "_")}`;

    try {
      await this.client.send(
        new CreateUserCommand({
          CollectionId: this.collectionId,
          UserId: userId,
        })
      );
      log.debug({ personName, userId }, "User created");
      return userId;
    } catch (error: any) {
      if (error.name === "ResourceInUseException") {
        // User already exists, return the existing ID
        log.debug({ personName, userId }, "User already exists");
        return userId;
      }
      throw error;
    }
  }

  /**
   * Associate face IDs with a user for aggregated vector matching.
   * @param userId - The user ID to associate faces with
   * @param faceIds - Array of face IDs from IndexFaces
   * @returns Object with counts of successfully and unsuccessfully associated faces
   */
  async associateFaces(
    userId: string,
    faceIds: string[]
  ): Promise<{ associated: number; failed: number }> {
    if (faceIds.length === 0) {
      return { associated: 0, failed: 0 };
    }

    // AWS allows max 100 faces per association call
    const maxFacesPerCall = 100;
    let totalAssociated = 0;
    let totalFailed = 0;

    for (let i = 0; i < faceIds.length; i += maxFacesPerCall) {
      const batch = faceIds.slice(i, i + maxFacesPerCall);

      const response = await this.client.send(
        new AssociateFacesCommand({
          CollectionId: this.collectionId,
          UserId: userId,
          FaceIds: batch,
        })
      );

      totalAssociated += response.AssociatedFaces?.length ?? 0;
      totalFailed += response.UnsuccessfulFaceAssociations?.length ?? 0;
    }

    log.debug(
      { userId, requested: faceIds.length, associated: totalAssociated, failed: totalFailed },
      "Faces associated with user"
    );

    return { associated: totalAssociated, failed: totalFailed };
  }

  /**
   * Search for users matching faces in an image using aggregated user vectors.
   */
  async searchUsers(imagePath: string): Promise<UserMatch[]> {
    return this.limiter.schedule(async () => {
      log.debug({ imagePath }, "Searching users");
      const imageBytes = await this.prepareImage(imagePath);

      try {
        const response = await this.client.send(
          new SearchUsersByImageCommand({
            CollectionId: this.collectionId,
            Image: { Bytes: imageBytes },
            MaxUsers: this.config.rekognition.searching.maxUsers,
            UserMatchThreshold: this.minConfidence,
          })
        );

        const matches: UserMatch[] = [];

        for (const userMatch of response.UserMatches ?? []) {
          if (userMatch.User && userMatch.Similarity) {
            const userId = userMatch.User.UserId ?? "";
            const personName = this.resolvePersonName(userId);

            matches.push({
              userId,
              personName,
              confidence: userMatch.Similarity,
              boundingBox: this.convertBoundingBox(
                response.SearchedFace?.FaceDetail?.BoundingBox
              ),
            });
          }
        }

        log.debug(
          { imagePath, matchCount: matches.length, matches: matches.map(m => ({ person: m.personName, confidence: m.confidence.toFixed(2) })) },
          "User search completed"
        );

        return matches;
      } catch (error: any) {
        if (error.name === "InvalidParameterException") {
          log.debug({ imagePath }, "No face detected in image");
          return [];
        }
        log.error({ imagePath, error: error.message }, "User search failed");
        throw error;
      }
    });
  }

  /**
   * List all users in the collection.
   * @returns Map of userId -> personName
   */
  async listUsers(): Promise<Map<string, string>> {
    const users = new Map<string, string>();
    let nextToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListUsersCommand({
          CollectionId: this.collectionId,
          MaxResults: 100,
          NextToken: nextToken,
        })
      );

      for (const user of response.Users ?? []) {
        const userId = user.UserId ?? "";
        users.set(userId, this.resolvePersonName(userId));
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return users;
  }

  /**
   * Delete a user from the collection.
   */
  async deleteUser(userId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteUserCommand({
          CollectionId: this.collectionId,
          UserId: userId,
        })
      );
      log.debug({ userId }, "User deleted");
    } catch (error: any) {
      if (error.name === "ResourceNotFoundException") {
        // User doesn't exist, that's fine
        return;
      }
      throw error;
    }
  }

  private async prepareImage(imagePath: string): Promise<Uint8Array> {
    const isHeic = imagePath.toLowerCase().endsWith(".heic");
    const { maxDimension, jpegQuality } = this.config.imageProcessing;

    let buffer: Buffer;
    try {
      buffer = readFileSync(imagePath);
      const metadata = await sharp(buffer).metadata();

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

      if (isHeic || metadata.format === "heif") {
        log.debug({ imagePath }, "Converting HEIC to JPEG");
        return await sharp(buffer).jpeg({ quality: jpegQuality }).toBuffer();
      }

      return buffer;
    } catch (error) {
      if (!isHeic) throw error;
      log.debug({ imagePath, error }, "Sharp HEIC decode failed, falling back to sips");
    }

    // Fallback: use macOS sips to convert HEIC → JPEG
    buffer = this.convertHeicWithSips(imagePath);
    const metadata = await sharp(buffer).metadata();

    if (
      (metadata.width && metadata.width > maxDimension) ||
      (metadata.height && metadata.height > maxDimension)
    ) {
      return await sharp(buffer)
        .resize(maxDimension, maxDimension, { fit: "inside" })
        .jpeg({ quality: jpegQuality })
        .toBuffer();
    }

    return buffer;
  }

  private convertHeicWithSips(imagePath: string): Buffer {
    const tempPath = join(tmpdir(), `claude-book-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    try {
      execSync(`sips -s format jpeg "${imagePath}" --out "${tempPath}"`, { stdio: "pipe" });
      return readFileSync(tempPath);
    } finally {
      try { unlinkSync(tempPath); } catch {}
    }
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
