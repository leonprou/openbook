import type { Config } from "../config";
import type { Exporter } from "./types";
import { FolderExporter } from "./folder";
import { ApplePhotosExporter } from "./albums";

export type ExporterType = "folder" | "apple-photos";

export function createExporter(config: Config): Exporter {
  return getExporter(config.export.backend, config);
}

export function getExporter(type: ExporterType, config: Config): Exporter {
  switch (type) {
    case "folder":
      return new FolderExporter(config.export.folder);
    case "apple-photos":
      return new ApplePhotosExporter(config.export.applePhotos);
    default:
      return new FolderExporter(config.export.folder);
  }
}

export * from "./types";
export { FolderExporter } from "./folder";
export { ApplePhotosExporter } from "./albums";
