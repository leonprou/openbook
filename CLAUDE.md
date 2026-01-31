# openbook

CLI tool for organizing family photos using face recognition with AWS Rekognition.

## Documentation

| File | Purpose |
|------|---------|
| `SKILL.md` | Claude skill for helping users interact with openbook |
| `docs/Architecture.md` | System architecture, data models, core processes, caching strategy |
| `docs/MANUAL.md` | Comprehensive CLI command reference |
| `README.md` | User-facing quick start and overview |

### Important for Claude

1. **Before planning**: Read `docs/Architecture.md` to understand system design and data flows
2. **Before training**: Always ask the user for explicit approval before running `bun run start train`. Never run training automatically.
3. **Before committing**: Update relevant documentation if changes affect:
   - CLI commands or options → update `SKILL.md` and `docs/MANUAL.md`
   - Architecture or data models → update `docs/Architecture.md`
   - User-facing features → update `README.md`
4. **For user interactions**: See `SKILL.md` for workflows on finding photos, scanning, approving/rejecting matches, and other user tasks

## Quick Reference

```bash
# Install dependencies
bun install

# Type checking
bun run typecheck

# Run CLI
bun run src/index.ts <command>
# or
bun run start <command>
```

For detailed command documentation, see `docs/MANUAL.md`.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Face Recognition**: AWS Rekognition
- **Image Processing**: Sharp
- **CLI Framework**: Commander.js
- **Config Validation**: Zod + YAML
- **Rate Limiting**: Bottleneck
- **Logging**: Pino
- **Database**: SQLite (better-sqlite3)

## Project Structure

```
src/
├── index.ts              # CLI entry point (Commander setup)
├── config.ts             # Configuration loading and Zod schema
├── logger.ts             # Pino logger setup
├── db/
│   └── index.ts          # SQLite database (persons, photos, scans, corrections)
├── utils/
│   └── hash.ts           # SHA256 file hashing for photo identification
├── rekognition/
│   ├── client.ts         # AWS Rekognition wrapper (indexFace, searchFaces)
│   └── types.ts          # Rekognition types
├── sources/
│   ├── local.ts          # Local filesystem photo source
│   └── types.ts          # Photo source interface
├── commands/
│   ├── init.ts           # Initialize config and AWS collection
│   ├── train.ts          # Index reference faces
│   ├── scan.ts           # Scan photos and match faces
│   ├── photos.ts         # Photo listing, approve/reject, export
│   ├── status.ts         # Show collection stats
│   ├── stats.ts          # Classification accuracy metrics
│   └── cleanup.ts        # Remove AWS collection
├── pipeline/
│   └── scanner.ts        # Photo scanning pipeline with parallel processing
└── export/
    └── albums.ts         # Apple Photos album creation via osxphotos
```

## Architecture

### Two-Phase Face Recognition

1. **Training Phase** (`train` command)
   - Scans `./references/<person_name>/` folders
   - Indexes faces to AWS Rekognition collection
   - Each folder name becomes the person identifier

2. **Scanning Phase** (`scan` command)
   - Processes photo library
   - Matches faces against trained collection
   - Creates Apple Photos albums per person

### Key Components

- **FaceRecognitionClient** (`src/rekognition/client.ts`): Wraps AWS Rekognition API with rate limiting (5 req/sec via Bottleneck)
- **Photo Sources** (`src/sources/`): Async generators for memory-efficient photo iteration
- **Image Preparation**: Auto-resizes images >4096px, converts HEIC to JPEG

## Configuration

File: `config.yaml` (created by `init` command)

```yaml
aws:
  region: us-east-1

rekognition:
  collectionId: openbook-faces
  minConfidence: 80           # Match threshold (0-100)
  searchMethod: faces         # "faces" (individual) or "users" (aggregated vectors)
  rateLimit:
    minTime: 200              # Minimum ms between requests
    maxConcurrent: 5          # Max concurrent API calls
  indexing:
    maxFaces: 1               # Faces to index per reference photo
    qualityFilter: AUTO       # NONE, AUTO, LOW, MEDIUM, HIGH
    detectionAttributes: DEFAULT  # DEFAULT or ALL
  searching:
    maxFaces: 10              # Max faces to search per photo
    maxUsers: 10              # Max users to search per photo (when searchMethod: users)

imageProcessing:
  maxDimension: 4096          # Max pixel dimension before resizing
  jpegQuality: 90             # Quality for JPEG conversion (1-100)

sources:
  local:
    paths:
      - ~/Pictures/Family
    extensions: [".jpg", ".jpeg", ".png", ".heic"]

training:
  referencesPath: ./references

albums:
  prefix: "openbook"       # Album naming: "openbook: Mom"

session:
  timeoutMinutes: 15          # Session cache validity

display:
  photoLimit: 250             # Max photos shown in list output
  pageSize: 50                # Results per page (with --page)
  progressBarWidth: 20        # Width of progress bar in characters
  columns:
    personName: 12            # Person name column width
    folder: 16                # Folder column width
    filename: 35              # Filename column width

scanning:
  concurrency: 10             # Parallel AWS requests (1-10)
  maxSortBuffer: 100000       # Max files to sort in memory
```

## Environment Variables

```bash
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_REGION=us-east-1
```

## External Dependencies

- **osxphotos**: Required for Apple Photos integration
  ```bash
  uv tool install osxphotos
  # or: pip install osxphotos
  ```

## Local Database

File: `.openbook.db` (SQLite, created automatically)

The database tracks:
- **persons**: Known people from training (name, face count, photo count)
- **photos**: Scanned photos with SHA256 hash, recognitions, and corrections
- **scans**: History of scan runs with stats
- **recognition_history**: Full audit trail of all recognitions

### Caching

Photos are identified by SHA256 content hash, so:
- Renamed/moved files are still recognized as cached
- Modified files are re-scanned
- Use `--rescan` to force re-scanning all photos

### Corrections

Three types of corrections:
- **approved**: Confirm a correct recognition
- **false_positive**: Mark an incorrect recognition (will be excluded in future)
- **false_negative**: Manually add a missed recognition

## Validation

To validate training worked correctly:

1. **Check status**: `openbook status` - shows indexed face count and database stats
2. **Test scan**: `openbook scan ./test-photos --dry-run`
3. **Adjust confidence**: Lower `minConfidence` for more matches, higher for fewer false positives
4. **Review corrections**: Use `photos reject` and `photos add` commands to improve accuracy

For common user workflows, see `SKILL.md`.
