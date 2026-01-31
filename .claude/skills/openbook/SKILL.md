---
name: openbook
description: |
  Help users organize family photos with face recognition. Use when users want to:
  find/show/review photos of specific people, scan folders for new photos,
  approve/reject face recognition matches, review pending photos, export to Apple Photos,
  or work with photo recognition results.
allowed-tools:
  - Bash(bun run start *)
  - Bash(ls *)
  - Read
  - Grep
argument-hint: "[person name or command]"
---

# openbook User Assistant

Help users interact with openbook, a CLI tool for organizing family photos using face recognition.

## When to Use This Skill

Invoke this skill when users ask to:
- Find, show, or review photos (e.g., "show me photos of Mom", "find photos from the last scan")
- Scan new photos or folders
- Approve or reject face recognition matches
- Review pending photos
- Export photos to Apple Photos
- Work with photo recognition results

If the user provides a person name as `$ARGUMENTS`, use it to filter photo operations.

## Current System State

Recent scans:
```
!`bun run start scan list --limit 3 2>/dev/null || echo "No scans found"`
```

Photo counts by status:
```
!`bun run start photos --status all --json 2>/dev/null | grep -c '"status"' || echo "0"` total photos indexed
```

Available people:
```
!`bun run start photos --json 2>/dev/null | grep -o '"person":"[^"]*"' | sort -u | head -5 || echo "No people indexed yet"`
```

## Core Principles

1. **Always use `bun run start`** instead of `openbook` when running commands from the project directory
2. **Default to approved photos** when showing photos (use `--status approved` by default)
3. **Never auto-run training** - always ask for explicit user approval before running `bun run start train`
4. **Always include `--open`** when the user asks to "show" photos (opens in Preview automatically)
5. **Ask for specific paths** - never scan root-level folders like `~/Pictures`, `~/Downloads`, or `~/Desktop`
6. **Never scan source folders** from `config.yaml` - they're too broad; ask for specific subfolders

## Quick Command Reference

| Task | Command Pattern |
|------|-----------------|
| **Show approved photos** | `bun run start photos --person "Name" --status approved --open` |
| **Show pending photos** | `bun run start photos --status pending --open` |
| **Scan new photos** | `bun run start scan <path> --person "Name"` |
| **Approve high confidence** | `bun run start photos approve --min-confidence 90 --all` |
| **Reject low confidence** | `bun run start photos reject --max-confidence 60` |
| **Export to Apple Photos** | `bun run start photos export --person "Name"` |

## Finding and Presenting Photos

When users ask to find, show, or review photos:

### 1. Run the Query

Use `bun run start photos` with filters:
```bash
# If $ARGUMENTS contains a person name:
bun run start photos --person "$ARGUMENTS" --status approved --open

# For pending review:
bun run start photos --status pending --open

# From specific scan:
bun run start photos --scan <id> --status pending --open

# With confidence filters:
bun run start photos --min-confidence 90 --max-confidence 100
```

**Key flags:**
- `--person "Name"` - filter by person
- `--status pending|approved|rejected|manual|all` - filter by review status (default: `approved`)
- `--scan <id>` - filter by scan run
- `--min-confidence N` / `--max-confidence N` - confidence range (0-100)
- `--open` - **always use when user says "show"** (opens in Preview)
- `--json` - get structured output for parsing

### 2. Present Results

Summarize for the user:
- **Counts** (e.g., "Found 23 photos of Mom")
- **Key details** (person, confidence, status)
- **Next actions** (approve, reject, export)

### 3. Take Action

Based on user review:
- `bun run start photos approve --all --without 3,7,12` - bulk approve except specific photos
- `bun run start photos reject <indexes>` - mark as false positives
- `bun run start photos add --person "Name" <photo-path>` - manually add missed faces

## Scanning for New Photos

**Directory caching** tracks modification times and skips unchanged directories automatically. Repeated scans are fast.

### Scan Workflow

1. **Get the path**
   - If not specified, ask the user
   - Suggest: subfolders from `ls` or paths from `bun run start scan list`
   - ⚠️ **Never scan root folders** (`~/Pictures`, `~/Downloads`, `~/Desktop`)
   - ⚠️ **Never scan source folders** from `config.yaml` - too broad, ask for specific subfolders

2. **Run the scan**
   ```bash
   # Basic scan with person filter (affects reporting only)
   bun run start scan <path> --person "$ARGUMENTS"

   # First-time scan on large library (safety limit)
   bun run start scan <path> --limit 500 --person "Name"

   # Force full rescan (rare, bypasses cache)
   bun run start scan <path> --rescan
   ```

3. **Report results**
   - Show scan ID, photos processed, faces found
   - If `--person` was used, show results for that person
   - Suggest next action (review pending photos)

## Photo Status Values

| Status | Description | When to Use |
|--------|-------------|-------------|
| `pending` | Recognized, not reviewed | Default for new recognitions |
| `approved` | Confirmed correct | After user verification |
| `rejected` | Marked as false positive | When recognition is wrong |
| `manual` | Manually added (false negative) | When face recognition missed someone |
| `all` | Show all statuses | When user wants complete view |

## Common Workflows

### 🔍 Review Pending Photos

1. **Show pending from latest scan**
   ```bash
   bun run start photos --scan <id> --status pending --open
   ```

2. **User reviews in Preview** (opened automatically)

3. **Approve all except wrong ones**
   ```bash
   bun run start photos approve --all --without 3,7,12
   # or reject specific
   bun run start photos reject 3,7,12
   ```

### 📸 Find Photos for a Person

```bash
# Approved only (default)
bun run start photos --person "$ARGUMENTS" --open

# All statuses
bun run start photos --person "$ARGUMENTS" --status all --open

# Pending review only
bun run start photos --person "$ARGUMENTS" --status pending --open
```

### ✅ Bulk Approval

```bash
# High-confidence matches from scan
bun run start photos approve --all --min-confidence 90 --scan <id>

# Person-specific with threshold
bun run start photos approve --person "$ARGUMENTS" --min-confidence 95 --all

# All except specific indexes
bun run start photos approve --all --without 3,5,8
```

### 🧹 Clean Up Low Confidence

```bash
# Preview first (always!)
bun run start photos reject --max-confidence 60 --dry-run

# Reject all low-confidence
bun run start photos reject --max-confidence 60

# Person-specific cleanup
bun run start photos reject --max-confidence 70 --person "$ARGUMENTS"
```

### 📤 Export to Apple Photos

```bash
# Export all approved (one album per person)
bun run start photos export

# Person-specific export
bun run start photos export --person "$ARGUMENTS"

# Preview first
bun run start photos export --dry-run
```

## Best Practices

### 🎯 Finding Photos
- ✅ **Always filter**: Use `--person`, `--status`, or `--scan` (never dump all photos)
- ✅ **Default to approved**: Unless user asks for pending/rejected/all
- ✅ **Use `--open` for "show"**: Launches Preview automatically
- ✅ **Summarize results**: Parse and present key stats, not raw output

### 🔎 Scanning
- ✅ **Ask for specific paths**: Never scan root/source folders
- ✅ **Check history**: `bun run start scan list` for previous paths
- ✅ **Safety limits**: `--limit 500` for first-time large scans
- ✅ **Person reporting**: `--person "Name"` filters post-scan output only
- ✅ **Trust the cache**: Re-scanning is fast, only new/changed dirs processed

### ⚡ Approving/Rejecting
- ✅ **Show first**: List photos so user sees indexes before action
- ✅ **Bulk operations**: Prefer `--all --without` over individual indexes
- ✅ **Confidence filters**: Bulk approve/reject by confidence threshold
- ✅ **Explain implications**: Approval → eligible for export; rejection → excluded

### 🎓 Training
- ⚠️ **NEVER auto-run**: Always ask explicit approval for `bun run start train`
- ✅ **Verify setup**: Confirm `./references/<person>/` structure exists
- ✅ **Explain process**: Indexes faces to AWS Rekognition collection

## Example Interactions

### 💬 "Show me photos of Mom from the last scan"
```bash
# Get latest scan ID
bun run start scan list --limit 1

# Show photos
bun run start photos --person "Mom" --scan <id> --status approved --open
```
**Response**: "Found 23 photos of Mom from scan #15. Opening in Preview now."

---

### 💬 "Find all pending photos and approve the good ones"
```bash
bun run start photos --status pending --open
```
**Response**: "Found 45 pending photos. Opening in Preview. After reviewing, tell me which to approve (or say 'approve all except [numbers]')."

---

### 💬 "Scan my vacation photos for Nina"
**Ask first**: "Which vacation folder? For example:
- `~/Pictures/Vacation2025/`
- `~/Pictures/Summer2024/`"

```bash
# Then scan
bun run start scan <user-provided-path> --person "Nina"
```

---

### 💬 "Reject all low-confidence matches for Dad"
```bash
# Preview first (ALWAYS)
bun run start photos reject --max-confidence 60 --person "Dad" --dry-run

# Then execute
bun run start photos reject --max-confidence 60 --person "Dad"
```
**Response**: "Found 8 photos of Dad with confidence ≤ 60%. Rejecting them now..."

---

### 💬 Using `/openbook Mom` directly
When invoked with arguments, `$ARGUMENTS` contains "Mom":
```bash
bun run start photos --person "Mom" --status approved --open
```

## Troubleshooting

### No photos found
- Check if people have been trained: `bun run start status`
- Verify scan has been run: `bun run start scan list`
- Try lowering confidence threshold in `config.yaml`

### Scan taking too long
- Use `--limit 500` to process in batches
- Check if directory caching is working (should skip unchanged dirs)
- Consider using `--person` to filter report (doesn't affect scan speed)

### Wrong face matches
- Reject low-confidence matches: `bun run start photos reject --max-confidence 70`
- Use `photos add` to manually add missed faces
- Consider retraining with better reference photos

### Training not working
- ⚠️ **Always ask user for approval before running `train`**
- Verify `./references/<person>/` structure exists
- Check AWS credentials are configured
- Review reference photos (should be clear, well-lit face shots)

## Tips for Claude

- 💡 **Parse JSON output** for better summaries: `--json | jq`
- 💡 **Check scan history** before asking paths: `bun run start scan list`
- 💡 **Use `--dry-run`** before bulk reject operations
- 💡 **Default to approved status** unless user explicitly asks for others
- 💡 **Always include `--open`** when user says "show"
- 💡 **Use `$ARGUMENTS`** for person name when invoked directly

## Documentation Reference

| File | Purpose |
|------|---------|
| `docs/MANUAL.md` | Comprehensive CLI command reference |
| `docs/Architecture.md` | System architecture, data models, caching |
| `README.md` | User-facing quick start guide |
| `config.yaml` | Configuration (confidence thresholds, paths, settings) |
