export interface PhotoInfo {
  path: string;
  filename: string;
  extension: string;
  size: number;
  modifiedAt: Date;
}

export interface PhotoSource {
  name: string;
  scan(): AsyncGenerator<PhotoInfo>;
  count(): Promise<number>;
}
