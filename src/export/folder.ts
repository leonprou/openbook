import {
  existsSync,
  mkdirSync,
  symlinkSync,
  copyFileSync,
  unlinkSync,
  lstatSync,
} from "fs";
import { join, basename } from "path";
import { createLogger } from "../logger";
import type { Exporter, ExportPhoto, ExportOptions, ExportResult } from "./types";
import type { Config } from "../config";

const log = createLogger("folder-export");

export class FolderExporter implements Exporter {
  name = "folder";
  private outputPath: string;
  private useSymlinks: boolean;
  private overwriteExisting: boolean;

  constructor(config: Config["export"]["folder"]) {
    this.outputPath = config.outputPath;
    this.useSymlinks = config.useSymlinks;
    this.overwriteExisting = config.overwriteExisting;
  }

  async isAvailable(): Promise<boolean> {
    return true; // Always available - no external dependencies
  }

  describeDestination(personName: string): string {
    return join(this.outputPath, personName);
  }

  async export(
    personPhotos: Map<string, ExportPhoto[]>,
    options: ExportOptions
  ): Promise<ExportResult[]> {
    const results: ExportResult[] = [];

    // Ensure base output directory exists
    if (!options.dryRun && !existsSync(this.outputPath)) {
      mkdirSync(this.outputPath, { recursive: true });
      log.debug({ outputPath: this.outputPath }, "Created output directory");
    }

    for (const [personName, photos] of personPhotos) {
      const result = await this.exportPerson(personName, photos, options);
      results.push(result);
    }

    return results;
  }

  private async exportPerson(
    personName: string,
    photos: ExportPhoto[],
    options: ExportOptions
  ): Promise<ExportResult> {
    const personDir = join(this.outputPath, personName);
    const result: ExportResult = {
      destination: personDir,
      photosExported: 0,
      photosSkipped: 0,
      errors: [],
    };

    if (options.dryRun) {
      result.photosExported = photos.length;
      return result;
    }

    // Ensure person directory exists
    if (!existsSync(personDir)) {
      mkdirSync(personDir, { recursive: true });
      log.debug({ personDir }, "Created person directory");
    }

    for (const photo of photos) {
      try {
        const filename = basename(photo.path);
        const destPath = join(personDir, filename);

        // Check if destination already exists
        if (existsSync(destPath)) {
          if (!this.overwriteExisting) {
            result.photosSkipped++;
            continue;
          }
          // Remove existing file/symlink
          unlinkSync(destPath);
        }

        // Check if source file exists
        if (!existsSync(photo.path)) {
          result.errors.push(`${filename}: Source file not found`);
          log.warn({ photo: photo.path }, "Source file not found");
          continue;
        }

        if (this.useSymlinks) {
          symlinkSync(photo.path, destPath);
        } else {
          copyFileSync(photo.path, destPath);
        }

        result.photosExported++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${basename(photo.path)}: ${message}`);
        log.error({ photo: photo.path, error: message }, "Failed to export photo");
      }
    }

    return result;
  }
}
