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
2. **Before training**: Always ask the user for explicit approval before running `bun run start train`. Never run training automatically.
3. **Before committing**: Update relevant documentation if changes affect:
   - CLI commands or options → update `CLAUDE.md` and `docs/MANUAL.md`
   - Architecture or data models → update `docs/Architecture.md`
   - User-facing features → update `README.md`

### Finding and Presenting Photos

When the user asks to find, show, or review photos (e.g. "show me photos of Mom", "find photos from the last scan", "what photos are pending?"), use the `claude-book` CLI:

1. **Find photos**: Run `bun run start photos` with appropriate filters:
   - `--person "Name"` to filter by person
   - `--status pending|approved|rejected|manual|all` to filter by review status
   - `--scan <id>` to filter by scan run
   - `--min-confidence N` / `--max-confidence N` to filter by recognition confidence
   - `--after YYYY-MM-DD` / `--before YYYY-MM-DD` to filter by photo capture date
   - `--json` for structured output you can parse and summarize

2. **Present results**: Summarize the output for the user — show counts, list file paths, and highlight key details (person, confidence, status). When the user asks to "show" photos, always include `--open` to open them in Preview automatically.

3. **Take action**: If the user wants to approve, reject, or add recognitions based on what they see, use the corresponding subcommands (`photos approve`, `photos reject`, `photos add`).

4. **Scan new photos**: If the user asks to scan a folder, run `bun run start scan <path>` and report the results.

5. **Default to approved photos**: When showing photos, use `--status approved` by default. Only use `--status pending`, `--status rejected`, or `--status all` when the user explicitly asks for those statuses (e.g., "show pending photos", "show all photos", "include rejected").

Always use `bun run start` (not `claude-book`) to invoke commands from this project directory.

### Scanning for New Photos

The scan command uses **directory caching** — it tracks each directory's modification time and skips unchanged directories entirely (no file enumeration or hashing needed). Repeated scans are fast automatically.

When the user asks to scan for new photos (e.g., "look for new Nina photos", "scan recent photos"):

1. **Path is required**: If the user doesn't specify a folder path, ask them which folder to scan. Suggest relevant options:
   - Subfolders within common locations (list them with `ls`)
   - Any paths from previous scans (check with `bun run start scan list`)
   - **Never scan root-level folders** like `~/Pictures`, `~/Downloads`, or `~/Desktop` directly — always ask the user to pick a specific subfolder
   - **Never scan source folders** from `config.yaml` → `sources.local.paths` — these are aggregation folders that likely contain photos from many different sources and are too broad to scan directly. Always ask the user to pick a specific subfolder within them instead.
2. **Just run the scan**: Directory caching makes repeated scans fast — only new/changed directories are processed
3. **Person-specific**: Use `--person "Name"` to filter the post-scan report to that person
4. **Safety limit**: For first-time scans on large libraries, add `--limit 500` as a safety net
5. **Force full rescan**: Use `--rescan` to bypass directory caching if needed

Example scan:
```bash
bun run start scan ~/Pictures/Family --person "Nina"
```

For first-time scans on large libraries:
```bash
bun run start scan ~/Pictures/Family --limit 500 --person "Nina"
```

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
| `claude-book stats` | Show classification accuracy metrics (per-person, by confidence) |
| `claude-book clear [--yes]` | Clear all photos from database (keeps training data) |

### Training Commands

| Command | Description |
|---------|-------------|
| `claude-book train <path>` | Index faces from reference folders |
| `claude-book train` | Use path from config.yaml |
| `claude-book train --path <path>` | Override references folder path |
| `claude-book train --person "Nina"` | Train only a specific person |
| `claude-book train cleanup [--yes]` | Remove AWS Rekognition collection |

### Persons Commands

| Command | Description |
|---------|-------------|
| `claude-book persons` | List all persons with stats |
| `claude-book persons --json` | Output as JSON |
| `claude-book persons show <name>` | Show detailed info for a person |
| `claude-book persons show <name> --json` | Output as JSON |

### Scan Commands

| Command | Description |
|---------|-------------|
| `claude-book scan <path>` | Scan photos at path |
| `claude-book scan --file <path...>` | Scan specific files by path |
| `claude-book scan <path> --dry-run` | Preview without making changes |
| `claude-book scan <path> --rescan` | Force re-scan of cached photos |
| `claude-book scan <path> --exclude "thumb"` | Exclude files containing "thumb" in filename |
| `claude-book scan <path> --person "Nina"` | Show only Nina's matches in post-scan report |
| `claude-book scan list` | List recent scans with stats |
| `claude-book scan show <id>` | Show details for a specific scan |
| `claude-book scan clear` | Clear all scans and reset recognitions |
| `claude-book scan clear --yes` | Clear without confirmation |

### Photos Commands

| Command | Description |
|---------|-------------|
| `claude-book photos` | List all scanned photos |
| `claude-book photos --person all` | List photos with any recognition |
| `claude-book photos --person "Mom"` | Filter by person |
| `claude-book photos --status pending` | Filter by status |
| `claude-book photos --scan 15` | Filter by scan ID |
| `claude-book photos --open` | Open results in Preview |
| `claude-book photos --json` | Output as JSON |
| `claude-book photos --min-confidence 80` | Filter by confidence >= 80% |
| `claude-book photos --max-confidence 70` | Filter by confidence <= 70% |
| `claude-book photos --file "name"` | Filter by filename (substring match) |
| `claude-book photos --after 2025-01-01` | Filter photos taken after date |
| `claude-book photos --before 2025-06-30` | Filter photos taken before date |
| `claude-book photos --page 2` | Show page 2 of results |
| `claude-book photos --per-page 25` | Set results per page (default: 50) |
| `claude-book photos approve <indexes>` | Approve by index (1,2,4-6) |
| `claude-book photos approve --all` | Approve all in current list |
| `claude-book photos approve --all --without 3,5` | Approve all except indexes |
| `claude-book photos approve --all --min-confidence 90` | Approve high-confidence matches |
| `claude-book photos approve --all --scan 45` | Approve all pending from scan |
| `claude-book photos approve --person "Mom" --min-confidence 95` | Approve high-confidence for person |
| `claude-book photos approve <person> <path>` | Approve specific photo |
| `claude-book photos reject <indexes>` | Reject by index |
| `claude-book photos reject --file "name.jpg"` | Reject by filename (must match 1 photo) |
| `claude-book photos reject --all --max-confidence 60` | Reject low-confidence matches |
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
  collectionId: claude-book-faces
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
  prefix: "Claude Book"       # Album naming: "Claude Book: Mom"

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
