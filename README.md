# Claude Book

A CLI tool for organizing family photos using face recognition. Automatically identifies family members in your photo library and organizes them into Apple Photos albums.

## What It Does

- **Scans** your photo library (local folders, iCloud Photos, Telegram exports)
- **Recognizes** faces using AWS Rekognition
- **Remembers** what it's scanned (no duplicate processing)
- **Learns** from your corrections (approve/reject matches)
- **Organizes** photos into Apple Photos albums by person

## Quick Start

```bash
# Install dependencies
bun install

# Install osxphotos (required for Apple Photos integration)
uv tool install osxphotos
# or: pip install osxphotos

# 1. Initialize (creates config, sets up AWS collection)
claude-book init

# 2. Train with reference photos
#    Create folders: ./references/mom/, ./references/dad/, ./references/kid1/
#    Add 3-5 clear face photos to each folder
claude-book train -r ./references

# 3. Scan your photo library
claude-book scan ~/Pictures/Family

# 4. Review and correct any mistakes
claude-book reject --person "Mom" --photo ~/Pictures/wrong_match.jpg

# 5. Re-scan uses cache, so it's fast!
claude-book scan ~/Pictures/Family
```

## Commands

| Command | Description |
|---------|-------------|
| `claude-book init` | Initialize config and AWS Rekognition collection |
| `claude-book train -r <path>` | Index faces from reference folders |
| `claude-book scan <path>` | Scan photos and create review albums |
| `claude-book scan <path> --dry-run` | Preview what albums would be created |
| `claude-book scan <path> --rescan` | Force re-scan of cached photos |
| `claude-book approve` | Approve review albums and create final albums |
| `claude-book approve --person "Name" --photo <path>` | Approve a specific recognition |
| `claude-book reject --person "Name" --photo <path>` | Mark recognition as incorrect |
| `claude-book add-match --person "Name" --photo <path>` | Manually add a missed recognition |
| `claude-book status` | Show collection info and database stats |
| `claude-book cleanup` | Remove AWS collection |

## Photo Memory

Claude Book remembers every photo it scans using a local SQLite database (`.claude-book.db`).

### How It Works

1. **SHA256 Hashing**: Each photo is identified by its content hash, not filename
2. **Smart Caching**: Already-scanned photos use cached results (no AWS calls)
3. **Move-Friendly**: Renamed or moved files are still recognized
4. **Re-scan Option**: Use `--rescan` to force fresh recognition

### Scan Output Example

```
$ claude-book scan ~/Photos

Scanning |████████████████| 100% | 1234/1234 | Matched: 89 | Cached: 892

Matches found:
  Mom: 45 photos (avg 92.3% confidence)
  Dad: 38 photos (avg 88.7% confidence)
  Sister: 6 photos (avg 95.1% confidence)

Cache stats: 892 from cache, 342 newly scanned
```

## Correcting Mistakes

When face recognition makes mistakes, teach it:

### False Positive (Wrong Match)

If "Mom" was incorrectly detected in a photo:

```bash
claude-book reject --person "Mom" --photo ~/Photos/vacation/IMG_001.jpg
```

Future scans will exclude this match.

### False Negative (Missed Detection)

If "Dad" is in a photo but wasn't detected:

```bash
claude-book add-match --person "Dad" --photo ~/Photos/vacation/IMG_002.jpg
```

Future scans will include this match.

### Confirming Correct Matches

To mark a match as verified correct:

```bash
claude-book approve --person "Mom" --photo ~/Photos/vacation/IMG_003.jpg
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI Layer                            │
│  init | train | scan | approve | reject | add-match | status │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Core Pipeline                           │
│  1. Hash photo → 2. Check cache → 3. Detect faces            │
│  4. Match people → 5. Apply corrections → 6. Create albums   │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Photo Sources │    │  Recognition  │    │ Local Database│
├───────────────┤    ├───────────────┤    ├───────────────┤
│ Local folders │    │ AWS           │    │ SQLite        │
│ iCloud Photos │    │ Rekognition   │    │ Persons       │
│ Telegram      │    │               │    │ Photos        │
│               │    │               │    │ Corrections   │
└───────────────┘    └───────────────┘    └───────────────┘
                                                  │
                                                  ▼
                                          ┌───────────────┐
                                          │ Album Export  │
                                          ├───────────────┤
                                          │ osxphotos     │
                                          │ Apple Photos  │
                                          └───────────────┘
```

### Data Flow

1. **Training Phase**
   ```
   Reference Photos → Detect Faces → Index to AWS Collection
   ./references/mom/*.jpg → face vectors → "claude-book-faces" collection
   ```

2. **Scanning Phase**
   ```
   Photo Library → Hash → Cache Check → Match Against Collection → Apply Corrections → Create Albums
   ~/Pictures/*.jpg → SHA256 → cached? → "mom: 94%" → not rejected? → "Claude Book: Mom" album
   ```

### Multi-Person Photos

Photos with multiple recognized people are added to **all** matching albums:
- Photo with Mom + Dad → added to both "Claude Book: Mom" AND "Claude Book: Dad"

## Tech Stack

| Technology | Purpose |
|------------|---------|
| **Bun** | Runtime - fast TypeScript execution |
| **TypeScript** | Type-safe development |
| **AWS Rekognition** | Face detection and recognition (~$1/1000 photos) |
| **SQLite** | Local database for caching and corrections |
| **osxphotos** | Apple Photos album creation |

### Dependencies

```
@aws-sdk/client-rekognition  - AWS face recognition API
better-sqlite3               - SQLite database for photo memory
sharp                        - Image processing and resizing
commander                    - CLI framework
zod                          - Config validation
bottleneck                   - API rate limiting
ora, cli-progress            - CLI progress indicators
```

## Configuration

Create `config.yaml` in the project root (auto-generated by `init`):

```yaml
aws:
  region: us-east-1

rekognition:
  collectionId: claude-book-faces
  minConfidence: 80              # Minimum match confidence (0-100)

sources:
  local:
    paths:
      - ~/Pictures/Family
    extensions:
      - ".jpg"
      - ".jpeg"
      - ".png"
      - ".heic"

training:
  referencesPath: ./references

albums:
  prefix: "Claude Book"          # Albums: "Claude Book: Mom", "Claude Book: Dad"
```

### Environment Variables

```bash
# AWS credentials (or use ~/.aws/credentials)
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_REGION=us-east-1
```

## Reference Photos Structure

Organize reference photos with one folder per person:

```
references/
├── mom/
│   ├── photo1.jpg      # Clear face, good lighting
│   ├── photo2.jpg      # Different angle
│   └── photo3.jpg      # 3-5 photos recommended
├── dad/
│   ├── photo1.jpg
│   └── photo2.jpg
└── kid1/
    ├── photo1.jpg
    └── photo2.jpg
```

**Tips for reference photos:**
- Use clear, well-lit photos with one face per image
- Include different angles and expressions
- 3-5 photos per person is usually sufficient
- Avoid group photos for training

## Database Files

Claude Book creates these files in your project directory:

| File | Purpose |
|------|---------|
| `.claude-book.db` | SQLite database with all scan data |
| `.claude-book-review.json` | Temporary state for review workflow |
| `config.yaml` | Your configuration |

### Database Contents

- **persons**: People from training (name, face count, photo count)
- **photos**: Scanned photos with recognitions and corrections
- **scans**: History of scan runs with statistics
- **recognition_history**: Full audit trail of all recognitions

## iCloud Photos Integration

iCloud Photos syncs to a local folder on macOS. Point claude-book at the Photos Library:

```bash
# Scan iCloud Photos library
claude-book scan ~/Pictures/Photos\ Library.photoslibrary/originals
```

Or export photos first for better results:
1. Select photos in Apple Photos
2. File → Export → Export Unmodified Originals
3. `claude-book scan ~/exported-photos`

## Telegram Integration

Family photos are often shared in Telegram groups:

### Step 1: Export from Telegram Desktop

1. Open **Telegram Desktop** (not mobile app)
2. Go to the group chat with family photos
3. Click **⋮** → **Export chat history**
4. Check **Photos**, choose export location
5. Click **Export**

### Step 2: Scan the Export

```bash
claude-book scan ~/Downloads/TelegramExport/photos
```

## Prerequisites

1. **AWS Account** with Rekognition access
2. **osxphotos** installed:
   ```bash
   uv tool install osxphotos
   # or: pip install osxphotos
   ```
3. **Bun** runtime: https://bun.sh

## Tuning Recognition

### Too Many False Positives?

Increase the confidence threshold in `config.yaml`:

```yaml
rekognition:
  minConfidence: 90  # Higher = fewer but more accurate matches
```

### Missing Too Many Photos?

Lower the confidence threshold:

```yaml
rekognition:
  minConfidence: 70  # Lower = more matches, some may be wrong
```

Use `reject` command to fix any mistakes.

## License

MIT
