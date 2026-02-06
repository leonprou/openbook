export interface ExportPhoto {
  path: string;
  hash: string;
  personName: string;
  photoDate?: string;
}

export interface ExportResult {
  destination: string;
  photosExported: number;
  photosSkipped: number;
  errors: string[];
}

export interface ExportOptions {
  dryRun?: boolean;
  person?: string;
}

export interface Exporter {
  name: string;
  isAvailable(): Promise<boolean>;
  export(
    personPhotos: Map<string, ExportPhoto[]>,
    options: ExportOptions
  ): Promise<ExportResult[]>;
  describeDestination(personName: string): string;
}
