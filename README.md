# openbook

A CLI tool for organizing family photos using face recognition. Automatically identifies family members in your photo library and organizes them into Apple Photos albums.

## What It Does

- **Scans** your photo library (local folders, iCloud Photos, Telegram exports)
- **Recognizes** faces using AWS Rekognition
- **Remembers** what it's scanned (no duplicate processing)
- **Learns** from your corrections (approve/reject matches)
- **Organizes** photos into Apple Photos albums by person

## Installation

### Prerequisites

1. **Bun runtime**: https://bun.sh
2. **AWS Account** with Rekognition access

### Install openbook

```bash
# Clone the repository
git clone https://github.com/leonprou/openbook.git
cd openbook

# Install dependencies
bun install

# Install globally (makes 'openbook' command available anywhere)
bun link
```

### Optional: Install osxphotos

Only required if you want to export albums to Apple Photos:

```bash
uv tool install osxphotos
# or: pip install osxphotos
```

### Running Without Global Install

If you prefer not to install globally, run commands from the project directory:

```bash
bun run start <command>
# Example: bun run start init
```

## Quick Start

```bash
# 1. Initialize (creates config, sets up AWS collection)
openbook init

# 2. Train with reference photos
#    Create folders: ./references/mom/, ./references/dad/, ./references/kid1/
#    Add 3-5 clear face photos to each folder
openbook train -r ./references

# 3. Scan your photo library
openbook scan ~/Pictures/Family

# 4. Review and correct any mistakes
openbook reject --person "Mom" --photo ~/Pictures/wrong_match.jpg

# 5. Re-scan uses cache, so it's fast!
openbook scan ~/Pictures/Family
```

## Commands

| Command | Description |
|---------|-------------|
| `openbook init` | Initialize config and AWS Rekognition collection |
| `openbook train -r <path>` | Index faces from reference folders |
| `openbook scan <path>` | Scan photos and create review albums |
| `openbook scan <path> --dry-run` | Preview what albums would be created |
| `openbook scan <path> --rescan` | Force re-scan of cached photos |
| `openbook approve` | Approve review albums and create final albums |
| `openbook approve --person "Name" --photo <path>` | Approve a specific recognition |
| `openbook reject --person "Name" --photo <path>` | Mark recognition as incorrect |
| `openbook add-match --person "Name" --photo <path>` | Manually add a missed recognition |
| `openbook status` | Show collection info and database stats |
| `openbook cleanup` | Remove AWS collection |

## Photo Memory

openbook remembers every photo it scans using a local SQLite database (`.openbook.db`).

### How It Works

1. **SHA256 Hashing**: Each photo is identified by its content hash, not filename
2. **Smart Caching**: Already-scanned photos use cached results (no AWS calls)
3. **Move-Friendly**: Renamed or moved files are still recognized
4. **Re-scan Option**: Use `--rescan` to force fresh recognition

### Scan Output Example

```
$ openbook scan ~/Photos

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
openbook reject --person "Mom" --photo ~/Photos/vacation/IMG_001.jpg
```

Future scans will exclude this match.

### False Negative (Missed Detection)

If "Dad" is in a photo but wasn't detected:

```bash
openbook add-match --person "Dad" --photo ~/Photos/vacation/IMG_002.jpg
```

Future scans will include this match.

### Confirming Correct Matches

To mark a match as verified correct:

```bash
openbook approve --person "Mom" --photo ~/Photos/vacation/IMG_003.jpg
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
   ./references/mom/*.jpg → face vectors → "openbook-faces" collection
   ```

2. **Scanning Phase**
   ```
   Photo Library → Hash → Cache Check → Match Against Collection → Apply Corrections → Create Albums
   ~/Pictures/*.jpg → SHA256 → cached? → "mom: 94%" → not rejected? → "openbook: Mom" album
   ```

### Multi-Person Photos

Photos with multiple recognized people are added to **all** matching albums:
- Photo with Mom + Dad → added to both "openbook: Mom" AND "openbook: Dad"

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
  collectionId: openbook-faces
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
  prefix: "openbook"          # Albums: "openbook: Mom", "openbook: Dad"
```

### Environment Variables

```bash
# AWS credentials (or use ~/.aws/credentials)
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_REGION=us-east-1
```

### For AI Agents (Restricted Access)

To create restricted IAM credentials that prevent accidental data loss:

```bash
# See docs/AWS-Setup-Openclaw.md for full setup instructions
./scripts/setup-openclaw-iam.sh
```

The restricted policy allows training and scanning but blocks collection deletion. Perfect for AI agents that need controlled access to AWS Rekognition.

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

openbook creates these files in your project directory:

| File | Purpose |
|------|---------|
| `.openbook.db` | SQLite database with all scan data |
| `.openbook-review.json` | Temporary state for review workflow |
| `config.yaml` | Your configuration |

### Database Contents

- **persons**: People from training (name, face count, photo count)
- **photos**: Scanned photos with recognitions and corrections
- **scans**: History of scan runs with statistics
- **recognition_history**: Full audit trail of all recognitions

## iCloud Photos Integration

iCloud Photos syncs to a local folder on macOS. Point openbook at the Photos Library:

```bash
# Scan iCloud Photos library
openbook scan ~/Pictures/Photos\ Library.photoslibrary/originals
```

Or export photos first for better results:
1. Select photos in Apple Photos
2. File → Export → Export Unmodified Originals
3. `openbook scan ~/exported-photos`

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
openbook scan ~/Downloads/TelegramExport/photos
```


## AWS Costs

openbook uses AWS Rekognition, which is **not free** but is very affordable for personal use.

### Pricing Overview (as of 2024)

- **Face Detection**: ~$1.00 per 1,000 images
- **Face Search**: ~$1.00 per 1,000 searches
- **Storage**: $0.01 per 1,000 face vectors per month

### Example Cost Scenarios

| Scenario | Photos | Cost (one-time) | Monthly Storage |
|----------|--------|-----------------|-----------------|
| Small library | 1,000 photos | ~$2 | ~$0.01/month |
| Medium library | 10,000 photos | ~$20 | ~$0.10/month |
| Large library | 50,000 photos | ~$100 | ~$0.50/month |

### Cost Optimization Tips

1. **Use the cache**: Re-scanning cached photos is free (no AWS calls)
2. **Start small**: Test with `--limit 500` before scanning your entire library
3. **Train efficiently**: Only 3-5 reference photos per person needed
4. **Review before export**: Fix mistakes before creating albums (no re-scanning needed)

### Free Tier

AWS Free Tier includes:
- 1,000 faces stored per month (first 12 months)
- 1,000 face searches per month (first 12 months)

For most personal photo libraries, costs are minimal after the initial scan.

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
