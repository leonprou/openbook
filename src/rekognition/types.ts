export interface IndexedFace {
  faceId: string;
  personName: string;
  imageId: string;
  confidence: number;
}

export interface FaceMatch {
  personName: string;
  confidence: number;
  faceId: string;
  boundingBox: BoundingBox;
}

export interface BoundingBox {
  width: number;
  height: number;
  left: number;
  top: number;
}

export interface DetectedFace {
  boundingBox: BoundingBox;
  confidence: number;
}

export interface CollectionInfo {
  collectionId: string;
  faceCount: number;
  createdAt?: Date;
}

export interface TrainingResult {
  personName: string;
  facesIndexed: number;
  errors: string[];
}

export interface ScanResult {
  photoPath: string;
  matches: FaceMatch[];
  processingTime: number;
}
