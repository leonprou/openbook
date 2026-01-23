export interface PhotoInfo {
  path: string;
  filename: string;
  extension: string;
  size: number;
  modifiedAt: Date;
  photoDate?: string;  // ISO 8601 date string
}

export interface PhotoSource {
  name: string;
  scan(): AsyncGenerator<PhotoInfo>;
  count(): Promise<number>;
}
