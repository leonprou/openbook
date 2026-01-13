import { readdirSync, statSync } from "fs";
import { join, extname, basename } from "path";
import type { PhotoInfo, PhotoSource } from "./types";

export interface LocalPhotoSourceOptions {
  limit?: number;
  filter?: RegExp;
}

export class LocalPhotoSource implements PhotoSource {
  name = "local";
  private paths: string[];
  private extensions: Set<string>;
  private limit?: number;
  private filter?: RegExp;

  constructor(paths: string[], extensions: string[], options?: LocalPhotoSourceOptions) {
    this.paths = paths;
    this.extensions = new Set(extensions.map((e) => e.toLowerCase()));
    this.limit = options?.limit;
    this.filter = options?.filter;
  }

  async *scan(): AsyncGenerator<PhotoInfo> {
    let yielded = 0;
    for (const basePath of this.paths) {
      for (const photo of this.scanDirectory(basePath)) {
        // Apply limit
        if (this.limit !== undefined && yielded >= this.limit) {
          return;
        }
        yielded++;
        yield photo;
      }
    }
  }

  async count(): Promise<number> {
    let count = 0;
    for await (const _ of this.scan()) {
      count++;
    }
    return count;
  }

  private *scanDirectory(dirPath: string): Generator<PhotoInfo> {
    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch (error) {
      // Directory doesn't exist or not accessible
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      // Skip hidden files and directories
      if (entry.name.startsWith(".")) {
        continue;
      }

      if (entry.isDirectory()) {
        yield* this.scanDirectory(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (this.extensions.has(ext)) {
          // Apply filter (match against filename only)
          if (this.filter && !this.filter.test(entry.name)) {
            continue;
          }

          try {
            const stats = statSync(fullPath);
            yield {
              path: fullPath,
              filename: basename(entry.name, ext),
              extension: ext,
              size: stats.size,
              modifiedAt: stats.mtime,
            };
          } catch {
            // File not accessible, skip
          }
        }
      }
    }
  }
}

export function scanReferencesDirectory(
  referencesPath: string,
  extensions: string[]
): Map<string, string[]> {
  const people = new Map<string, string[]>();
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));

  let entries;
  try {
    entries = readdirSync(referencesPath, { withFileTypes: true });
  } catch {
    return people;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const personName = entry.name;
    const personPath = join(referencesPath, personName);
    const photos: string[] = [];

    try {
      const files = readdirSync(personPath, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && !file.name.startsWith(".")) {
          const ext = extname(file.name).toLowerCase();
          if (extSet.has(ext)) {
            photos.push(join(personPath, file.name));
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }

    if (photos.length > 0) {
      people.set(personName, photos);
    }
  }

  return people;
}
