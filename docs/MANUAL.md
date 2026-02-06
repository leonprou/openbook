# openbook Command Manual

A CLI tool for organizing family photos using face recognition with AWS Rekognition.

## Quick Reference

```
openbook init                          Initialize project
openbook train <path>                  Train with reference photos
openbook persons                       List people and stats
openbook scan <path>                   Scan photos for faces
openbook photos                        List and manage recognized photos
openbook status                        Show stats
openbook cleanup                       Remove AWS collection
```

---

## Commands

### init

Initialize openbook configuration.

```
openbook init [--local]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--local` | Create config in current directory instead of global location |

**Default behavior (global config):**

Creates files in `~/.config/openbook/`:
- `config.yaml` - Configuration file
- `.openbook.db` - SQLite database (created on first use)
- `.openbook-session.json` - Session state

Also creates:
- AWS Rekognition collection

**With `--local` flag:**

Creates `config.yaml` in the current directory. This is useful for project-specific configurations. When a local `config.yaml` exists, it takes precedence over the global config.

**Example:**
```bash
# Standard setup (recommended)
$ openbook init
✓ Created config file: ~/.config/openbook/config.yaml
✓ Created AWS Rekognition collection: openbook-faces

Ready! Next steps:
  1. Add reference photos to ./references/<person>/
  2. Run: openbook train ./references

# Project-specific setup
$ openbook init --local
✓ Created config file: ./config.yaml
```

---

### train

Index reference faces for recognition.

```
openbook train [path]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `path` | Path to references folder (default: from config.yaml) |

**Options:**
| Option | Description |
|--------|-------------|
| `--path <path>` | Path to references folder (overrides config) |
| `--person <name>` | Train only a specific person |
| `--verbose` | Show detailed indexing progress |

**Reference folder structure:**
```
references/
├── mom/
│   ├── photo1.jpg
│   ├── photo2.jpg
│   └── photo3.jpg
├── dad/
│   └── photo1.jpg
└── sister/
    ├── photo1.jpg
    └── photo2.jpg
```

Each subfolder name becomes the person's identifier.

**Examples:**
```bash
# Train from default path
$ openbook train

# Train from specific path
$ openbook train ./references
$ openbook train ~/Dropbox/family-faces

# With verbose output
$ openbook train ./references --verbose
```

**Output:**
```
Training faces...

  mom      3 faces indexed
  dad      2 faces indexed
  sister   2 faces indexed

✓ Indexed 7 faces for 3 people
```

**Tips:**
- Use 3-5 clear photos per person
- Include different angles and lighting
- Avoid group photos for training
- One face per photo works best

---

### train show

Show reference photos used to train a person.

```
openbook train show <person> [options]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `person` | Person name |

**Options:**
| Option | Description |
|--------|-------------|
| `-o, --open` | Open photos in Preview |

**Example:**
```bash
$ openbook train show mom

Reference photos for "mom":
  ~/references/mom/photo1.jpg
  ~/references/mom/photo2.jpg
  ~/references/mom/photo3.jpg

3 reference photos
```

---

### train cleanup

Remove AWS Rekognition collection (all trained face data).

```
openbook train cleanup [--yes]
```

**Options:**
| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompt |

**Example:**
```bash
$ openbook train cleanup

This will delete the AWS Rekognition collection:
  Collection: openbook-faces

All indexed faces will be permanently deleted.

Are you sure you want to continue? [y/N] y
✓ Collection deleted successfully

To start fresh, run:
  openbook init
  openbook train -r ./references
```

---

### persons

List all trained people and their recognition stats.

```
openbook persons [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

**Output columns:** Name, Faces (indexed), Photos (matched), Approval %, Trained date.

**Example:**
```bash
$ openbook persons

People:
──────────────────────────────────────────────────────────
Name         Faces  Photos  Approval %  Trained
──────────────────────────────────────────────────────────
Ada          15     418     94.5%       2025-01-15
Nina         6      0       -           2025-01-20
──────────────────────────────────────────────────────────
2 person(s) total.
```

---

### persons show

Show detailed info for a specific person.

```
openbook persons show <name> [options]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `name` | Person name (case-insensitive) |

**Options:**
| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

**Shows:**
- Basic info (display name, trained date, face/photo counts)
- Recognition status breakdown (approved/rejected/pending + approval rate)
- Confidence stats (min/avg/max)
- Recent matches (last 5 photos with confidence, status, date)

**Example:**
```bash
$ openbook persons show Ada

Person: Ada

  Trained:       1/15/2025, 10:23:45 AM
  Face count:    15
  Photo count:   418

Recognition Status:
  Approved:      350
  Rejected:      12
  Pending:       56
  Approval rate: 96.7%

Confidence:
  Min: 72.3%   Avg: 91.5%   Max: 99.8%

Recent Matches:
  99.2%  approved   2025-01-20  ~/Pictures/Family/IMG_1234.jpg
  95.1%  pending    2025-01-20  ~/Pictures/Family/IMG_1230.jpg
  88.7%  approved   2025-01-19  ~/Pictures/Vacation/DSC_0042.jpg
```

---

### scan

Scan photos to find and match faces.

```
openbook scan [path] [options]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `path` | Path to photos (required unless `--file` is used) |

**Options:**
| Option | Description |
|--------|-------------|
| `--file <path...>` | Scan specific files by path (bypasses directory walking) |
| `--dry-run` | Preview matches without saving |
| `--rescan` | Force re-scan of cached photos |
| `--limit <n>` | Limit number of new photos to scan |
| `--after <date>` | Only include photos after date (YYYY-MM-DD) |
| `--before <date>` | Only include photos before date (YYYY-MM-DD) |
| `--person <name>` | Filter post-scan report to specific person (implies `--report`) |
| `--filter <regex>` | Filter files by regex pattern (matches filename) |
| `--exclude <pattern>` | Exclude files containing pattern in filename |
| `--report` | Show photos report after scan completes |
| `--verbose` | Show detailed progress |

**Examples:**
```bash
# Scan a folder
$ openbook scan ~/Pictures/Family
$ openbook scan ~/Pictures/Vacation --dry-run

# Scan specific files
$ openbook scan --file ~/Pictures/photo1.jpg ~/Pictures/photo2.heic

# Force rescan (ignore cache)
$ openbook scan ~/Pictures --rescan
```

**Output:**
```
Scanning ~/Pictures/Family...

|████████████████████████████████| 1234/1234

Cache: 892 cached, 342 new

New matches found:
  Mom: 45 photos (avg 92.3% confidence)
  Dad: 38 photos (avg 88.7% confidence)
  Sister: 6 photos (avg 95.1% confidence)

Found Photos:
 #   Person       Confidence  Path
────────────────────────────────────────────────────────────────────────────────
  1  Mom          94.2%       ~/Pictures/Family/IMG_1234.jpg
  2  Mom          91.8%       ~/Pictures/Family/IMG_1235.jpg
  3  Dad          89.5%       ~/Pictures/Family/IMG_1240.jpg
...

Showing 50 of 89 photos.
Use 'openbook photos --scan 15' for full list.

Next steps:
  openbook photos --scan 15           Review photos from this scan
  openbook photos approve <indexes>   Approve correct matches
  openbook photos reject <indexes>    Reject false positives
  openbook photos export              Create albums for approved photos
```

---

### scan list

Show scan history.

```
openbook scan list [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--limit <n>` | Number of scans to show (default: 10) |
| `--json` | Output as JSON |

**Example:**
```bash
$ openbook scan list

ID   Date                 Photos   Matches  New    Source
15   2024-01-15 14:30    234      89       42     ~/Pictures/Family
14   2024-01-10 09:15    156      45       156    ~/Downloads/Telegram
13   2024-01-08 11:00    892      234      0      ~/Pictures/Family
12   2024-01-05 16:45    50       12       50     ~/Desktop/imports
```

---

### scan show

Show details for a specific scan.

```
openbook scan show <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Scan ID from `scan list` |

**Example:**
```bash
$ openbook scan show 15

Scan #15
────────────────────────────────
Date:       2024-01-15 14:30:22
Source:     ~/Pictures/Family
Duration:   2m 34s

Photos:     234 total
  Cached:   192
  Scanned:  42

Matches by person:
  Mom       45 photos
  Dad       38 photos
  Sister     6 photos

Status:
  Pending:   67
  Approved:  18
  Rejected:   4
```

---

### photos

List scanned photos with optional filters.

```
openbook photos [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--person <name>` | Filter by person name (use `all` for any recognized) |
| `--status <status>` | Filter by status (see below) |
| `--scan <id>` | Filter by scan ID |
| `--after <date>` | Only include photos after date (YYYY-MM-DD) |
| `--before <date>` | Only include photos before date (YYYY-MM-DD) |
| `--file <name>` | Filter by filename (substring match) |
| `--open` | Open photos in Preview app |
| `--limit <n>` | Max results (default: 250) |
| `--offset <n>` | Skip first n results |
| `-p, --page <n>` | Page number (1-indexed) |
| `--per-page <n>` | Results per page (default: 50, from config) |
| `--json` | Output as JSON |

**Status values:**
| Status | Description |
|--------|-------------|
| `pending` | Not yet reviewed (includes unrecognized photos) |
| `approved` | Confirmed correct |
| `rejected` | Marked as wrong |
| `manual` | Manually added |
| `all` | Show all statuses |

**Default behavior:**
- `photos` → shows ALL scanned photos (including unrecognized)
- `photos --person all` → shows only photos with recognitions
- `photos --person "Mom"` → shows only photos recognized as Mom

**Examples:**
```bash
# List all scanned photos
$ openbook photos

# List only photos with recognitions
$ openbook photos --person all

# List photos for specific person
$ openbook photos --person "Mom"

# List approved photos only
$ openbook photos --status approved

# List photos from a specific scan
$ openbook photos --scan 15

# Combine filters
$ openbook photos --person "Mom" --status pending --scan 15

# Open in Preview for visual review
$ openbook photos --person "Mom" --open

# Filter by date range
$ openbook photos --person "Mom" --after 2025-01-01
$ openbook photos --after 2025-06-01 --before 2025-08-31

# Paginate through results
$ openbook photos --page 2
$ openbook photos --page 3 --per-page 25

# JSON output for scripting
$ openbook photos --json
```

**Output:**
```
$ openbook photos --person "Mom"

 #   Status    Confidence  Path
 1   pending   94.2%       ~/Pictures/vacation/IMG_001.jpg
 2   pending   91.8%       ~/Pictures/vacation/IMG_002.jpg
 3   pending   67.3%       ~/Pictures/party/IMG_100.jpg
 4   approved  96.1%       ~/Pictures/birthday/IMG_050.jpg
 5   pending   89.5%       ~/Pictures/christmas/IMG_200.jpg

Showing 5 of 45 photos (Mom, pending)
```

---

### photos approve

Mark photos as correctly recognized.

```
openbook photos approve <indexes>
openbook photos approve --all [--without <indexes>]
openbook photos approve <person> <path>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `indexes` | Indexes from last `photos` list |
| `person` | Person name (when approving by path) |
| `path` | Photo file path (when approving by path) |

**Options:**
| Option | Description |
|--------|-------------|
| `--all` | Approve all photos in current list |
| `--without <indexes>` | Exclude these indexes from `--all` |
| `--scan <id>` | Filter by scan ID (use `latest` for most recent) |
| `--dry-run` | Preview without making changes |

**Index formats:** `1` | `1,2,4` | `1-5` | `1,3-5,8`

**Examples:**
```bash
# First, list and review photos from a scan
$ openbook photos --scan 15 --status pending --open

 #   Person   Confidence  Path
 1   Mom      94.2%       ~/Pictures/IMG_001.jpg
 2   Mom      91.8%       ~/Pictures/IMG_002.jpg
 3   Mom      67.3%       ~/Pictures/IMG_003.jpg  ← wrong
 4   Dad      95.1%       ~/Pictures/IMG_004.jpg
 5   Dad      52.1%       ~/Pictures/IMG_005.jpg  ← wrong

# Approve all except wrong ones
$ openbook photos approve --all --without 3,5
✓ Approved 3 photos (skipped 2)

# Or approve specific indexes
$ openbook photos approve 1,2,4

# Approve by person and path (no prior list needed)
$ openbook photos approve "Mom" ~/Pictures/photo.jpg

# Preview what would be approved
$ openbook photos approve --all --dry-run
```

**Output:**
```
$ openbook photos approve --all --without 3,5

✓ Approved 3 photos (skipped 2)
  Mom:  ~/Pictures/IMG_001.jpg
  Mom:  ~/Pictures/IMG_002.jpg
  Dad:  ~/Pictures/IMG_004.jpg
```

---

### photos reject

Mark photos as incorrectly recognized (false positives).

```
openbook photos reject <indexes>
openbook photos reject --file <filename>
openbook photos reject --all [--without <indexes>]
openbook photos reject --max-confidence <n> [--person <name>]
openbook photos reject <person> <path>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `indexes` | Indexes from last `photos` list |
| `person` | Person name (when rejecting by path) |
| `path` | Photo file path (when rejecting by path) |

**Options:**
| Option | Description |
|--------|-------------|
| `--all` | Reject all photos in current list |
| `--without <indexes>` | Exclude these indexes from `--all` |
| `--file <filename>` | Reject by filename (must match exactly 1 photo) |
| `--max-confidence <n>` | Reject photos with confidence ≤ n% |
| `--person <name>` | Filter for `--max-confidence` |
| `--dry-run` | Preview without making changes |

**Examples:**
```bash
# Reject specific indexes
$ openbook photos reject 3,5

# Reject by filename (from last photos list)
$ openbook photos reject --file "photo_24971@06-06-2025.jpg"

# Reject all in list except good ones
$ openbook photos reject --all --without 1,2,4

# Bulk reject low-confidence matches (safe cleanup)
$ openbook photos reject --max-confidence 60
⚠ This will reject 23 photos with confidence ≤ 60%
Continue? [y/N] y
✓ Rejected 23 photos

# Reject low-confidence for specific person
$ openbook photos reject --max-confidence 70 --person "Mom"
✓ Rejected 8 photos for Mom

# Preview what would be rejected
$ openbook photos reject --max-confidence 60 --dry-run

# Reject by person and path (no prior list needed)
$ openbook photos reject "Mom" ~/Pictures/wrong_match.jpg
```

**Output:**
```
$ openbook photos reject 3

✓ Rejected 1 photo for Mom
  ~/Pictures/party/IMG_100.jpg

This photo will be excluded from future Mom albums.
```

---

### photos add

Manually add a recognition (for missed detections).

```
openbook photos add <person> <path>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `person` | Person name to add |
| `path` | Photo file path |

**Example:**
```bash
# Add Dad to a photo where he wasn't detected
$ openbook photos add "Dad" ~/Pictures/family_dinner.jpg

✓ Added Dad to ~/Pictures/family_dinner.jpg
```

Use this when face recognition missed someone in a photo.

---

### photos export

Export approved photos to folders or Apple Photos albums.

```
openbook photos export [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--person <name>` | Export only this person's photos |
| `--backend <type>` | Export backend: `folder` (default) or `apple-photos` |
| `--output <path>` | Output directory (folder backend only) |
| `--copy` | Copy files instead of creating symlinks (folder backend) |
| `--album <name>` | Custom album name (Apple Photos only) |
| `--dry-run` | Preview without exporting |

**Backends:**

| Backend | Description |
|---------|-------------|
| `folder` | Creates folders with symlinks to photos (default) |
| `apple-photos` | Creates Apple Photos albums via osxphotos |

**Examples:**
```bash
# Default: export to folders with symlinks
$ openbook photos export

# Specify output directory
$ openbook photos export --output ~/Desktop/family-photos

# Copy files instead of symlinks
$ openbook photos export --copy

# Export for specific person
$ openbook photos export --person "Mom"

# Use Apple Photos backend
$ openbook photos export --backend apple-photos

# Apple Photos with custom album name
$ openbook photos export --backend apple-photos --album "Mom - 2024 Vacation"

# Preview what would be created
$ openbook photos export --dry-run
```

**Output (folder backend):**
```
$ openbook photos export

Exporting 89 approved photos for 3 people using folder...

  ✓ ~/Pictures/openbook-export/Mom: 45 photos
  ✓ ~/Pictures/openbook-export/Dad: 38 photos
  ✓ ~/Pictures/openbook-export/Sister: 6 photos

Done! Exported 89 photos to ~/Pictures/openbook-export
```

**Output (Apple Photos backend):**
```
$ openbook photos export --backend apple-photos

Exporting 89 approved photos for 3 people using apple-photos...

  ✓ openbook: Mom: 45 photos
  ✓ openbook: Dad: 38 photos
  ✓ openbook: Sister: 6 photos

Done! Exported 89 photos to Apple Photos.
```

**Notes:**
- **Symlinks (default):** Save disk space by creating links to original files. If originals move, links break.
- **Copy mode:** Creates actual copies. Uses more disk space but fully portable.
- **Apple Photos:** Requires `osxphotos` to be installed (`uv tool install osxphotos`).

---

### status

Show collection information and statistics.

```
openbook status
```

**Example:**
```bash
$ openbook status

openbook Status
──────────────────────────────────

AWS Collection: openbook-faces
  Region:     us-east-1
  Faces:      7 indexed

People:
  Mom         3 reference faces, 45 photos
  Dad         2 reference faces, 38 photos
  Sister      2 reference faces, 6 photos

Database:
  Photos:     1,892 scanned
  Matches:    534 total
  Pending:    67 to review
  Approved:   412
  Rejected:   55

Last scan:   2024-01-15 14:30 (Scan #15)
```

---

### clear

Clear all photos from the database while keeping training data.

```
openbook clear [--yes]
```

**Options:**
| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompt |

**What gets cleared:**
- All photo records
- All scan history
- All recognition history

**What is preserved:**
- Persons (training data)
- AWS Rekognition collection (indexed faces)

**Example:**
```bash
$ openbook clear

This will delete all photos and scans from the database.
Training data (persons) will be preserved.

Are you sure? [y/N] y
Cleared 1892 photo(s) and 15 scan(s).
```

---

## Workflows

### First-Time Setup

```bash
# 1. Initialize
openbook init

# 2. Create reference folders
mkdir -p references/mom references/dad references/kids

# 3. Add 3-5 clear face photos to each folder
cp ~/clear-photos/mom*.jpg references/mom/
cp ~/clear-photos/dad*.jpg references/dad/

# 4. Train the model
openbook train ./references

# 5. Verify training worked
openbook status
```

### Daily Photo Review

```bash
# 1. Scan new photos
openbook scan ~/Pictures/Recent

# 2. Review photos from scan
openbook photos --scan 15 --status pending --open

# 3. Approve all except wrong ones
openbook photos approve --all --without 3,7,12

# 4. Export to Apple Photos
openbook photos export
```

### Bulk Approval with Exceptions

```bash
# List and view all pending from a scan
openbook photos --scan 15 --status pending --open

# Review visually, note the wrong ones, approve rest
openbook photos approve --all --without 5,8,14

# Reject the wrong ones explicitly
openbook photos reject 5,8,14
```

### Clean Up Low-Confidence Matches

```bash
# Preview what would be rejected
openbook photos reject --max-confidence 60 --dry-run

# Reject all low-confidence matches
openbook photos reject --max-confidence 60

# Or just for one person
openbook photos reject --max-confidence 70 --person "Mom"
```

### Quick Scan Review

```bash
# View pending photos from latest scan
openbook photos --scan 15 --status pending --open

# If all look correct, approve everything
openbook photos approve --all

# Or approve with a few exceptions
openbook photos approve --all --without 3,7
```

### Re-scanning After Corrections

After rejecting false positives or adding missed recognitions:

```bash
# Normal scan uses cache and applies corrections
openbook scan ~/Pictures

# Force complete rescan if needed
openbook scan ~/Pictures --rescan
```

### Scripting & Automation

```bash
# Get pending counts as JSON
openbook photos --status pending --json | jq 'group_by(.person) | map({person: .[0].person, count: length})'

# Export specific scan results to CSV
openbook photos --scan 15 --json | jq -r '[.path, .person, .confidence] | @csv' > scan15.csv

# Find low-confidence matches to review
openbook photos --status pending --json | jq -r 'select(.confidence < 70) | "\(.confidence)% \(.person) \(.path)"'

# Bulk reject low-confidence (with confirmation)
openbook photos reject --max-confidence 60
```

---

## Configuration

### config.yaml

```yaml
aws:
  region: us-east-1                    # AWS region

rekognition:
  collectionId: openbook-faces      # Collection name
  minConfidence: 80                    # Match threshold (0-100)

sources:
  local:
    paths:
      - ~/Pictures/Family              # Folders to scan
      - ~/Pictures/Vacation
    extensions:
      - ".jpg"
      - ".jpeg"
      - ".png"
      - ".heic"

training:
  referencesPath: ./references         # Reference photos location

albums:
  prefix: "openbook"                   # Album prefix (legacy, use export.applePhotos.prefix)

export:
  backend: folder                      # "folder" (default) or "apple-photos"
  folder:
    outputPath: ~/Pictures/openbook-export
    useSymlinks: true                  # true = symlinks, false = copy files
    overwriteExisting: false           # Skip existing files
  applePhotos:
    prefix: "openbook"                 # Album prefix for Apple Photos
```

### Environment Variables

```bash
# AWS credentials (or use ~/.aws/credentials)
export AWS_ACCESS_KEY_ID=your_key
export AWS_SECRET_ACCESS_KEY=your_secret
export AWS_REGION=us-east-1
```

---

## Tuning Recognition

### Too Many False Positives?

Increase confidence threshold:

```yaml
# config.yaml
rekognition:
  minConfidence: 90  # Higher = stricter matching
```

### Missing Too Many Photos?

Lower confidence threshold:

```yaml
# config.yaml
rekognition:
  minConfidence: 70  # Lower = more matches
```

Then use `photos reject` to fix any mistakes.

---

## Files Created

**Global files** (in `~/.config/openbook/`):

| File | Purpose |
|------|---------|
| `config.yaml` | Your configuration |
| `.openbook.db` | SQLite database (scans, matches, corrections) |
| `.openbook-session.json` | Temporary session state |

**Local override** (optional):

| File | Purpose |
|------|---------|
| `./config.yaml` | Project-specific config (takes precedence if present) |

Create a local config with `openbook init --local` when you need different settings for a specific project.

---

## Troubleshooting

### "No faces found in reference photos"

- Ensure photos have clear, visible faces
- Check photos aren't too small (min 80x80 pixels for face)
- Try different photos with better lighting

### "AWS credentials not configured"

```bash
# Option 1: Environment variables
export AWS_ACCESS_KEY_ID=your_key
export AWS_SECRET_ACCESS_KEY=your_secret

# Option 2: AWS credentials file
aws configure
```

### "Photo not found in database"

The photo hasn't been scanned yet. Run:
```bash
openbook scan /path/to/photo/folder
```

### Slow scanning performance

- Photos are cached by content hash
- First scan is slower; subsequent scans use cache
- Use `--rescan` only when necessary

### Albums not appearing in Apple Photos

- Ensure `osxphotos` is installed: `uv tool install osxphotos` or `pip install osxphotos`
- Note: osxphotos is only required for the `photos export` command - all other features work without it
- Check Apple Photos is running
- Grant terminal access to Photos in System Preferences > Privacy
- Verify osxphotos is in your PATH: `which osxphotos`
