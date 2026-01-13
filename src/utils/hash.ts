import { createHash } from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";

export interface FileInfo {
  hash: string;
  size: number;
}

/**
 * Compute SHA256 hash of a file using streaming to handle large files efficiently
 */
export async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Get file info including hash and size
 */
export async function getFileInfo(filePath: string): Promise<FileInfo> {
  const [hash, stats] = await Promise.all([
    computeFileHash(filePath),
    stat(filePath),
  ]);

  return {
    hash,
    size: stats.size,
  };
}
