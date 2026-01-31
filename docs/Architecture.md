# Architecture

## Overview

openbook uses a two-phase face recognition system:

1. **Training** - Index reference photos of known people to AWS Rekognition
2. **Scanning** - Match faces in your photo library against trained faces
3. **Review** - Approve or reject matches, add missed people
4. **Export** - Create Apple Photos albums for approved matches

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Training   │────▶│  Scanning   │────▶│   Review    │────▶│   Export    │
│             │     │             │     │             │     │ (optional)  │
│ references/ │     │ Photo lib   │     │ approve/    │     │ osxphotos   │
│ → AWS       │     │ → matches   │     │ reject      │     │ → Albums    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLI Layer                                   │
│  src/commands/   init | train | scan | approve | status | list          │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Pipeline Layer │     │   Data Layer    │     │ External Services│
│                 │     │                 │     │                 │
│ src/pipeline/   │     │ src/db/         │     │ src/rekognition/│
│ - scanner.ts    │◀───▶│ - SQLite DB     │     │ - AWS client    │
│                 │     │ - persons       │     │                 │
│ src/sources/    │     │ - photos        │     │ src/export/     │
│ - local.ts      │     │ - scans         │     │ - albums.ts     │
│ - types.ts      │     │ - corrections   │     │ - osxphotos*    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

*osxphotos is optional - only required for the `photos export` command

### Directory Structure

| Directory | Purpose |
|-----------|---------|
| `src/commands/` | CLI command handlers |
| `src/pipeline/` | Photo processing logic |
| `src/sources/` | Photo source adapters (local filesystem) |
| `src/db/` | SQLite database operations |
| `src/rekognition/` | AWS Rekognition API client |
| `src/export/` | Apple Photos album creation |
| `src/utils/` | Utilities (file hashing) |

## Data Models

### Entity Relationships

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   persons   │         │   photos    │         │    scans    │
├─────────────┤         ├─────────────┤         ├─────────────┤
│ id (PK)     │◀──┐     │ hash (PK)   │    ┌───▶│ id (PK)     │
│ name        │   │     │ path        │    │    │ started_at  │
│ face_count  │   │     │ last_scan_id│────┘    │ completed_at│
│ photo_count │   └─────│ recognitions│ (JSON)  │ stats...    │
└─────────────┘         │ corrections │ (JSON)  └─────────────┘
                        └─────────────┘
                               │
                               ▼
                  ┌────────────────────────┐
                  │  recognition_history   │
                  ├────────────────────────┤
                  │ id (PK)                │
                  │ photo_hash (FK)        │
                  │ scan_id (FK)           │
                  │ recognitions (JSON)    │
                  └────────────────────────┘
```

### Table Schemas

**persons** - Trained people from reference photos
```sql
id INTEGER PRIMARY KEY
name TEXT UNIQUE NOT NULL      -- folder name from references/
face_count INTEGER             -- indexed faces in AWS
photo_count INTEGER            -- matched photos count
user_id TEXT                   -- AWS Rekognition User ID (for searchMethod: users)
```

**photos** - Scanned photos (keyed by content hash)
```sql
hash TEXT PRIMARY KEY          -- SHA256 of file contents
path TEXT NOT NULL             -- last known file path
last_scan_id INTEGER           -- FK to scans table
recognitions TEXT              -- JSON: [{personId, personName, confidence, boundingBox}]
corrections TEXT               -- JSON: [{personId, type: approved|false_positive|false_negative}]
```

**scans** - Audit trail of scan runs
```sql
id INTEGER PRIMARY KEY
started_at TEXT NOT NULL
completed_at TEXT
source_paths TEXT              -- JSON array of scanned directories
photos_processed INTEGER
photos_cached INTEGER
matches_found INTEGER
```

### JSON Structures

**Recognition** (stored in photos.recognitions):
```json
{
  "personId": 1,
  "personName": "Mom",
  "confidence": 94.5,
  "faceId": "abc-123",
  "boundingBox": {"left": 0.1, "top": 0.2, "width": 0.3, "height": 0.4},
  "searchMethod": "faces"       // "faces" (individual vectors) or "users" (aggregated)
}
```

**Correction** (stored in photos.corrections):
```json
{
  "personId": 1,
  "personName": "Mom",
  "type": "approved",         // or "false_positive" or "false_negative"
  "createdAt": "2024-01-15T10:30:00Z"
}
```

## Photo Status Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                          SCAN                                    │
│   AWS Rekognition analyzes photos for faces                     │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        PENDING                                   │
│   Initial state. Awaiting human review.                         │
│   • Match found → shows person name + confidence %              │
│   • No match → shows "(no match)" with 0.0%                     │
└─────────────────────────────┬───────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
┌───────────────────┐ ┌───────────────┐ ┌───────────────────┐
│     APPROVED      │ │   REJECTED    │ │      MANUAL       │
│                   │ │               │ │                   │
│ User confirmed    │ │ False positive│ │ User added a      │
│ recognition is    │ │ Wrong match,  │ │ missed person     │
│ correct           │ │ excluded from │ │ (false negative   │
│                   │ │ future use    │ │ correction)       │
└─────────┬─────────┘ └───────────────┘ └─────────┬─────────┘
          │                                       │
          └───────────────────┬───────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         EXPORT                                   │
│   Only approved + manual photos are exported to Apple Photos    │
└─────────────────────────────────────────────────────────────────┘
```

### Status Definitions

| Status | Description | Exported? |
|--------|-------------|-----------|
| `pending` | Recognition awaiting review | No |
| `approved` | User confirmed match is correct | Yes |
| `rejected` | Marked as false positive (wrong match) | No |
| `manual` | User manually added person (missed by AI) | Yes |

## Core Processes

### Training Process

**Entry point**: `src/commands/train.ts`

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ references/ │────▶│ Scan dirs   │────▶│ IndexFaces  │────▶│ persons     │
│ mom/        │     │             │     │ API         │     │ table       │
│ dad/        │     │ person →    │     │             │     │             │
│ ...         │     │ [photos]    │     │ faceId ←    │     │ face_count  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

1. Scan `references/` directory for person folders
2. For each person folder, find all photo files
3. Call AWS `IndexFaces` API for each photo
4. Create/update `persons` record with face count
5. Faces stored in AWS Rekognition collection (not local DB)

### Scanning Process

**Entry point**: `src/commands/scan.ts` → `src/pipeline/scanner.ts`

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Scanning Sequence                                 │
└──────────────────────────────────────────────────────────────────────────┘

 Photo Source         Scanner              Database           AWS Rekognition
      │                  │                    │                     │
      │  async yield     │                    │                     │
      │────────────────▶│                    │                     │
      │   PhotoInfo      │                    │                     │
      │                  │                    │                     │
      │                  │  getFileInfo()     │                     │
      │                  │  (SHA256 hash)     │                     │
      │                  │                    │                     │
      │                  │  getPhotoByHash()  │                     │
      │                  │───────────────────▶│                     │
      │                  │                    │                     │
      │                  │◀───────────────────│                     │
      │                  │  cached? ──────────┼─────────────────────┤
      │                  │     │              │                     │
      │                  │     │ NO           │                     │
      │                  │     ▼              │                     │
      │                  │  searchFaces()     │                     │
      │                  │─────────────────────────────────────────▶│
      │                  │                    │                     │
      │                  │◀─────────────────────────────────────────│
      │                  │  FaceMatch[]       │                     │
      │                  │                    │                     │
      │                  │  savePhoto()       │                     │
      │                  │───────────────────▶│                     │
      │                  │                    │                     │
      │                  │  saveRecogHistory()│                     │
      │                  │───────────────────▶│                     │
      │                  │     │              │                     │
      │                  │     │ YES (cached) │                     │
      │                  │     ▼              │                     │
      │                  │  Use cached        │                     │
      │                  │  recognitions      │                     │
      │                  │                    │                     │
      │                  │  Apply corrections │                     │
      │                  │  Filter by minConf │                     │
      │                  │                    │                     │
      │                  │  Return PhotoMatch │                     │
      │                  │                    │                     │
```

Key files:
- `src/pipeline/scanner.ts:69-204` - Main scanning loop
- `src/sources/local.ts` - Async generator for photo discovery
- `src/utils/hash.ts` - SHA256 computation

### Corrections & Export Process

**Entry point**: `src/commands/approve.ts`

```
User Action           Database              Export
     │                   │                    │
     │  approve/reject   │                    │
     │──────────────────▶│                    │
     │                   │                    │
     │  addCorrection()  │                    │
     │  (updates JSON)   │                    │
     │                   │                    │
     │  export cmd       │                    │
     │──────────────────▶│                    │
     │                   │                    │
     │  getEffective     │                    │
     │  Matches()        │                    │
     │◀──────────────────│                    │
     │                   │                    │
     │  (filters out     │                    │
     │  false_positive,  │                    │
     │  adds false_neg)  │                    │
     │                   │                    │
     │  createAlbums()   │                    │
     │─────────────────────────────────────▶│
     │                   │                    │
     │                   │  osxphotos CLI     │
     │                   │  → Apple Photos    │
```

## Caching Strategy

### Content-Based Addressing

Photos are identified by SHA256 hash of file contents:

```
/path/to/photo.jpg  ───▶  SHA256  ───▶  "abc123..."  ───▶  DB lookup
```

**Benefits**:
- File renames/moves don't cause re-scanning
- Duplicate files detected automatically
- Content changes trigger re-scan

**Implementation**: `src/utils/hash.ts`

### Cache Invalidation

| Scenario | Behavior |
|----------|----------|
| Same file, same content | Use cached recognitions |
| Same file, modified content | New hash → re-scan |
| File moved/renamed | Same hash → use cache |
| `--rescan` flag | Force re-scan all photos |

## AWS Rekognition Integration

**Client**: `src/rekognition/client.ts`

### Rate Limiting

Uses Bottleneck library to limit API calls:
- **Rate**: 5 requests/second
- **Concurrent**: 1 request at a time

### Search Methods

openbook supports two face matching methods via `searchMethod` config:

| Method | API | Description | Best For |
|--------|-----|-------------|----------|
| `faces` (default) | `SearchFacesByImage` | Compare against individual face vectors | Few reference photos (1-3) per person |
| `users` | `SearchUsersByImage` | Compare against aggregated user vectors | Many reference photos (5+) per person |

**Individual Face Vectors (`faces`)**
```
Reference photos    →    Individual face vectors
├── Mom/photo1.jpg  →    FaceVector_A (best match: 87%)
├── Mom/photo2.jpg  →    FaceVector_B (best match: 92%) ← returned
└── Mom/photo3.jpg  →    FaceVector_C (best match: 78%)
```
Each reference photo creates a separate vector. Matches compare against each individually.

**Aggregated User Vectors (`users`)**
```
Reference photos    →    Aggregated user vector
├── Mom/photo1.jpg  ─┐
├── Mom/photo2.jpg  ─┼→  UserVector_Mom (match: 94%)
└── Mom/photo3.jpg  ─┘
```
All reference faces are aggregated into a single user representation. Better for:
- Handling variation (glasses, lighting, angles)
- Reducing false positives (strangers that match one specific photo)

**Switching Methods**
1. Change `searchMethod` in config.yaml
2. Run `train cleanup --yes` to remove old collection
3. Run `train` to re-index with the new method

### Image Preparation

Before sending to AWS:
1. Images >4096px are resized (Sharp library)
2. HEIC files converted to JPEG
3. Temporary file created for upload

### API Calls

| Operation | API | When |
|-----------|-----|------|
| Training | `IndexFaces` | `train` command |
| User creation | `CreateUser` | `train` (when `searchMethod: users`) |
| User association | `AssociateFaces` | `train` (when `searchMethod: users`) |
| Scanning (faces) | `SearchFacesByImage` | `scan` (when `searchMethod: faces`) |
| Scanning (users) | `SearchUsersByImage` | `scan` (when `searchMethod: users`) |
| Status | `DescribeCollection` | `status` command |
| Cleanup | `DeleteCollection` | `cleanup` command |

## Configuration

### config.yaml

```yaml
aws:
  region: us-east-1

rekognition:
  collectionId: openbook-faces
  minConfidence: 80              # Match threshold (0-100)
  searchMethod: faces            # "faces" (individual) or "users" (aggregated)
  rateLimit:
    minTime: 200                 # Minimum ms between API requests
    maxConcurrent: 5             # Max concurrent API calls
  indexing:
    maxFaces: 1                  # Faces to index per reference photo
    qualityFilter: AUTO          # NONE, AUTO, LOW, MEDIUM, HIGH
    detectionAttributes: DEFAULT # DEFAULT or ALL
  searching:
    maxFaces: 10                 # Max faces to search per photo
    maxUsers: 10                 # Max users to search per photo (when searchMethod: users)

imageProcessing:
  maxDimension: 4096             # Max pixel dimension before resizing
  jpegQuality: 90                # JPEG quality for conversion (1-100)

sources:
  local:
    paths:
      - ~/Pictures/Family
    extensions: [".jpg", ".jpeg", ".png", ".heic"]

training:
  referencesPath: ./references

albums:
  prefix: "openbook"          # Album naming: "openbook: Mom"

session:
  timeoutMinutes: 15             # Session cache validity

display:
  photoLimit: 250                # Max photos shown in list output
  progressBarWidth: 20           # Progress bar width in characters
  columns:
    personName: 12               # Person name column width
    folder: 16                   # Folder column width
    filename: 35                 # Filename column width

scanning:
  concurrency: 10                # Parallel AWS requests (1-10)
  maxSortBuffer: 100000          # Max files to sort in memory
```

### Environment Variables

```bash
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_REGION=us-east-1             # Optional, overrides config
```

## Key Concepts

- **Recognitions**: Raw detections from AWS Rekognition (person + confidence %)
- **Corrections**: User feedback that modifies recognition status
- **Effective matches**: Final result after applying corrections (used for export)

Photos are identified by content hash (SHA256), so renamed/moved files stay cached.
