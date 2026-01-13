# Claude Book

CLI tool for organizing family photos using face recognition with AWS Rekognition.

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

## CLI Commands

| Command | Description |
|---------|-------------|
| `claude-book init` | Initialize config and AWS Rekognition collection |
| `claude-book train -r <path>` | Index faces from reference folders |
| `claude-book scan -p <path>` | Scan photos and create Apple Photos albums |
| `claude-book scan --dry-run` | Preview what albums would be created |
| `claude-book scan --rescan` | Force re-scan of cached photos |
| `claude-book approve` | Approve review albums and create final albums |
| `claude-book approve --person "Mom" --photo <path>` | Approve a specific recognition |
| `claude-book reject --person "Mom" --photo <path>` | Mark recognition as false positive |
| `claude-book add-match --person "Mom" --photo <path>` | Manually add missed recognition |
| `claude-book status` | Show collection info and stats |
| `claude-book cleanup` | Remove AWS collection |

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
│   ├── approve.ts        # Approve/reject/add-match corrections
│   ├── status.ts         # Show collection stats
│   └── cleanup.ts        # Remove AWS collection
├── pipeline/
│   └── scanner.ts        # Photo scanning pipeline with caching
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
  collectionId: claude-book-faces
  minConfidence: 80  # Match threshold (0-100)

sources:
  local:
    paths:
      - ~/Pictures/Family
    extensions: [".jpg", ".jpeg", ".png", ".heic"]

training:
  referencesPath: ./references

albums:
  prefix: "Claude Book"  # Album naming: "Claude Book: Mom"
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

File: `.claude-book.db` (SQLite, created automatically)

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

1. **Check status**: `claude-book status` - shows indexed face count and database stats
2. **Test scan**: `claude-book scan -p ./test-photos --dry-run`
3. **Adjust confidence**: Lower `minConfidence` for more matches, higher for fewer false positives
4. **Review corrections**: Use `reject` and `add-match` commands to improve accuracy
