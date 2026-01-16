# Claude Book

CLI tool for organizing family photos using face recognition with AWS Rekognition.

## Documentation

| File | Purpose |
|------|---------|
| `docs/Architecture.md` | System architecture, data models, core processes, caching strategy |
| `docs/MANUAL.md` | Comprehensive CLI command reference |
| `README.md` | User-facing quick start and overview |

### Important for Claude

1. **Before planning**: Read `docs/Architecture.md` to understand system design and data flows
2. **Before committing**: Update relevant documentation if changes affect:
   - CLI commands or options → update `CLAUDE.md` and `docs/MANUAL.md`
   - Architecture or data models → update `docs/Architecture.md`
   - User-facing features → update `README.md`

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

### Setup Commands

| Command | Description |
|---------|-------------|
| `claude-book init` | Initialize config and AWS Rekognition collection |
| `claude-book status` | Show collection info and stats |
| `claude-book cleanup [--yes]` | Remove AWS collection |

### Training Commands

| Command | Description |
|---------|-------------|
| `claude-book train <path>` | Index faces from reference folders |
| `claude-book train` | Use path from config.yaml |

### Scan Commands

| Command | Description |
|---------|-------------|
| `claude-book scan <path>` | Scan photos at path |
| `claude-book scan` | Use paths from config.yaml |
| `claude-book scan --dry-run` | Preview without making changes |
| `claude-book scan --rescan` | Force re-scan of cached photos |
| `claude-book scan --exclude "thumb"` | Exclude files containing "thumb" in filename |
| `claude-book scan list` | List recent scans with stats |
| `claude-book scan show <id>` | Show details for a specific scan |
| `claude-book scan clear` | Clear all scans and reset recognitions |
| `claude-book scan clear --yes` | Clear without confirmation |

### Photos Commands

| Command | Description |
|---------|-------------|
| `claude-book photos` | List photos (default: approved) |
| `claude-book photos --person "Mom"` | Filter by person |
| `claude-book photos --status pending` | Filter by status |
| `claude-book photos --scan 15` | Filter by scan ID |
| `claude-book photos --open` | Open results in Preview |
| `claude-book photos --json` | Output as JSON |
| `claude-book photos approve <indexes>` | Approve by index (1,2,4-6) |
| `claude-book photos approve --all` | Approve all in current list |
| `claude-book photos approve --all --without 3,5` | Approve all except indexes |
| `claude-book photos approve <person> <path>` | Approve specific photo |
| `claude-book photos reject <indexes>` | Reject by index |
| `claude-book photos reject --max-confidence 60` | Reject low-confidence matches |
| `claude-book photos add <person> <path>` | Manually add person to photo |
| `claude-book photos export` | Export all approved to Apple Photos |
| `claude-book photos export --person "Mom"` | Export for specific person |

### Photo Status Values

| Status | Description |
|--------|-------------|
| `pending` | Recognized, not reviewed |
| `approved` | Confirmed correct |
| `rejected` | Marked as false positive |
| `manual` | Manually added (false negative correction) |
| `all` | Show all statuses |

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
2. **Test scan**: `claude-book scan ./test-photos --dry-run`
3. **Adjust confidence**: Lower `minConfidence` for more matches, higher for fewer false positives
4. **Review corrections**: Use `photos reject` and `photos add` commands to improve accuracy

## Workflow Example

```bash
# 1. Scan new photos
claude-book scan ~/Pictures/Recent

# 2. Review pending photos from the scan
claude-book photos --scan 15 --status pending --open

# 3. Approve all except wrong ones
claude-book photos approve --all --without 3,7,12

# 4. Clean up low-confidence matches
claude-book photos reject --max-confidence 60

# 5. Export approved to Apple Photos
claude-book photos export
```
