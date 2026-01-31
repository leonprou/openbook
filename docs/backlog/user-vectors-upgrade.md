# Feature: Upgrade to AWS Rekognition User Vectors

> **Status: Completed** (2026-01-23)

## Problem

Current implementation uses individual face vectors for matching. This can lead to:
- **False positives**: A stranger matches one specific reference photo well
- **False negatives**: Person with variation (glasses, lighting) doesn't match any single reference well

## Current Approach: Individual Face Vectors

### How Training Works (`src/commands/train.ts`)

```
references/
├── Mom/
│   ├── photo1.jpg  →  IndexFaces  →  FaceVector_A (ExternalImageId: "Mom")
│   ├── photo2.jpg  →  IndexFaces  →  FaceVector_B (ExternalImageId: "Mom")
│   └── photo3.jpg  →  IndexFaces  →  FaceVector_C (ExternalImageId: "Mom")
└── Dad/
    └── photo1.jpg  →  IndexFaces  →  FaceVector_D (ExternalImageId: "Dad")
```

Each reference photo creates a separate face vector in the collection. They're linked only by the `ExternalImageId` tag (the person's name).

**Current Implementation Details:**
- `src/commands/train.ts:79-102` - Main training loop
- `src/rekognition/client.ts:96-133` - `indexFace()` method
- Line 108: `ExternalImageId: personName` - The only linkage between faces and persons

### How Searching Works (`src/rekognition/client.ts:135-190`)

```
Photo to scan  →  SearchFacesByImage  →  Compare against ALL individual vectors
                                          ├── FaceVector_A: 87% match
                                          ├── FaceVector_B: 92% match  ← Best match
                                          └── FaceVector_C: 78% match
                                      →  Returns: "Mom" with 92% confidence
```

The search compares against each individual face vector separately, then deduplicates (lines 165-173) to keep only the highest confidence per person.

**Current Implementation Details:**
- `src/rekognition/client.ts:141-148` - `SearchFacesByImageCommand` call
- `src/rekognition/client.ts:165-173` - Deduplication by person name
- `src/pipeline/scanner.ts:559-580` - `convertMatchesToRecognitions()` bridges AWS to DB

### Problem: Single Point of Comparison

The match confidence depends on which single reference photo the scanned face happens to look most like. If Mom is wearing glasses in the scanned photo but none of the reference photos have glasses, all individual comparisons might be low.

---

## User Vectors Approach: Aggregated Representation

### How Training Would Work

```
references/
├── Mom/
│   ├── photo1.jpg  →  IndexFaces  →  FaceVector_A ─┐
│   ├── photo2.jpg  →  IndexFaces  →  FaceVector_B ─┼─→ AssociateFaces →  UserVector_Mom
│   └── photo3.jpg  →  IndexFaces  →  FaceVector_C ─┘                     (aggregates all 3)
└── Dad/
    └── photo1.jpg  →  IndexFaces  →  FaceVector_D ───→ AssociateFaces →  UserVector_Dad
```

After indexing faces, you call:
1. `CreateUser` - creates a user container (e.g., `user_mom`)
2. `AssociateFaces` - links FaceVector_A, B, C to `user_mom`

AWS internally creates an aggregated representation that encodes the variation across all associated faces.

### How Searching Would Work

```
Photo to scan  →  SearchUsersByImage  →  Compare against aggregated UserVectors
                                          ├── UserVector_Mom: 94% match  ← Aggregated!
                                          └── UserVector_Dad: 45% match
                                      →  Returns: "Mom" with 94% confidence
```

The match is against the combined representation of all Mom's faces, not against any single one.

---

## Side-by-Side Comparison

| Aspect             | Current (Individual Vectors)  | User Vectors                |
|--------------------|-------------------------------|-----------------------------|
| API - Index        | `IndexFacesCommand`           | `IndexFacesCommand` (same)  |
| API - Create User  | N/A                           | `CreateUserCommand` (new)   |
| API - Associate    | N/A                           | `AssociateFacesCommand` (new) |
| API - Search       | `SearchFacesByImageCommand`   | `SearchUsersByImageCommand` |
| Match basis        | Best single face vector       | Aggregated user vector      |
| Max faces/person   | Unlimited (but redundant)     | Up to 100 associated        |
| Variation handling | Depends on luck of best match | Built into aggregation      |

---

## Why User Vectors Reduce False Positives

### Scenario: Mom with glasses

**Current approach:**
```
Reference: 3 photos of Mom without glasses
Scanned:   Photo of Mom WITH glasses

SearchFacesByImage results:
  FaceVector_A: 72% (below threshold)
  FaceVector_B: 75% (below threshold)
  FaceVector_C: 71% (below threshold)

Result: No match (false negative) or low-confidence match
```

**User Vectors approach:**
```
Reference: 3 photos of Mom without glasses
Scanned:   Photo of Mom WITH glasses

SearchUsersByImage results:
  UserVector_Mom: 89% (aggregation handles variation better)

Result: Confident match
```

### Scenario: Stranger looks like one reference photo

**Current approach:**
```
Reference: 3 photos of Mom
Scanned:   Photo of stranger who happens to look like photo2

SearchFacesByImage results:
  FaceVector_B: 85% match  ← Matches one specific photo well!

Result: False positive (stranger identified as Mom)
```

**User Vectors approach:**
```
Reference: 3 photos of Mom
Scanned:   Photo of stranger

SearchUsersByImage results:
  UserVector_Mom: 62% (stranger doesn't match the aggregate)

Result: Below threshold, no false positive
```

The aggregation acts as a statistical regularizer - a face needs to match the "essence" of all reference photos, not just happen to look like one specific shot.

---

## Dual-Mode Strategy

Both search methods are supported as permanent options via configuration:

### Configuration (`config.yaml`)

```yaml
rekognition:
  searchMethod: faces    # "faces" (default) or "users"
```

### How It Works

| Config Value | Training | Scanning |
|--------------|----------|----------|
| `faces` (default) | Index faces only | `SearchFacesByImageCommand` |
| `users` | Index faces + create users + associate | `SearchUsersByImageCommand` |

### User Workflow

**To use individual face vectors (current behavior):**
```yaml
rekognition:
  searchMethod: faces
```
```bash
openbook train
openbook scan
```

**To use aggregated user vectors:**
```yaml
rekognition:
  searchMethod: users
```
```bash
openbook train cleanup --yes  # Remove old collection
openbook train                 # Re-train with user creation
openbook scan                  # Uses searchUsers automatically
```

### Switching Between Methods

When switching from `faces` to `users`:
1. Change config to `searchMethod: users`
2. Run `train cleanup --yes` to remove old collection (users require fresh training)
3. Run `train` to create faces AND users

When switching from `users` to `faces`:
1. Change config to `searchMethod: faces`
2. Scanning immediately uses `searchFaces` (existing faces work)
3. Optionally re-train if you want to remove user data

### Mode Mismatch Detection

The scanner must validate that training data matches the configured `searchMethod`:

```typescript
// In scanner, before processing photos:
if (config.rekognition.searchMethod === 'users') {
  const persons = getAllPersons();
  const missingUsers = persons.filter(p => !p.userId);

  if (missingUsers.length > 0) {
    throw new Error(
      `searchMethod is 'users' but ${missingUsers.length} person(s) lack user vectors. ` +
      `Run 'train cleanup --yes && train' to create user vectors.`
    );
  }
}
// 'faces' mode always works - face vectors are indexed regardless of mode
```

**Why this works:**
- `faces` → `users`: Scanner blocks until re-training creates users
- `users` → `faces`: Works immediately (face vectors always exist)
- Partial state (some with userId, some without): Scanner blocks, requires full re-train

**Info message for potential upgrade:**
```typescript
// When using 'faces' mode but users exist:
if (config.rekognition.searchMethod === 'faces') {
  const persons = getAllPersons();
  const withUsers = persons.filter(p => p.userId);

  if (withUsers.length > 0) {
    logger.info(
      `${withUsers.length} person(s) have user vectors available. ` +
      `Consider 'searchMethod: users' for better accuracy.`
    );
  }
}
```

### Why Keep Both?

| Use Case | Recommended Method |
|----------|-------------------|
| Few reference photos per person (1-3) | `faces` - aggregation needs more data |
| Many reference photos per person (5+) | `users` - better variation handling |
| High false positive rate | `users` - statistical regularization |
| High false negative rate (variations) | `users` - aggregation handles diversity |
| Quick experimentation | `faces` - simpler, faster training |

---

## Implementation Changes Required

### 1. Database Schema Changes (`src/db/index.ts`)

Add `user_id` column to persons table:

```sql
ALTER TABLE persons ADD COLUMN user_id TEXT;
```

Update Person interface:
```typescript
export interface Person {
  id: number;
  name: string;
  displayName: string | null;
  notes: string | null;
  trainedAt: string;
  faceCount: number;
  photoCount: number;
  userId: string | null;  // NEW: AWS Rekognition User ID
}
```

Add new methods:
- `updatePersonUserId(personId: number, userId: string): void`

### 2. Rekognition Client Changes (`src/rekognition/client.ts`)

Add new methods:

```typescript
// Create a user in the collection
async createUser(personName: string): Promise<string> {
  // Returns userId (e.g., "user_mom")
}

// Associate face IDs with a user
async associateFaces(userId: string, faceIds: string[]): Promise<void> {
  // Links faces to user for aggregation
}

// Search using aggregated user vectors
async searchUsers(imagePath: string): Promise<UserMatch[]> {
  // Similar to searchFaces but uses SearchUsersByImageCommand
}

// List users in collection
async listUsers(): Promise<string[]> {
  // For status/debugging
}

// Delete a user
async deleteUser(userId: string): Promise<void> {
  // For cleanup
}
```

New types in `src/rekognition/types.ts`:
```typescript
export interface UserMatch {
  userId: string;
  personName: string;
  confidence: number;
  boundingBox: BoundingBox;
}
```

### 3. Config Schema Changes (`src/config.ts`)

Add new config option:

```typescript
rekognition: z.object({
  // ... existing fields
  searchMethod: z.enum(['faces', 'users']).default('faces'),
})
```

### 4. Training Command Changes (`src/commands/train.ts`)

Update training workflow to conditionally create users:

```typescript
// 1. Scan references directory (unchanged)
// 2. For each person, index faces with indexFace() (unchanged)
// 3. Collect all faceIds indexed for this person (NEW - track faceIds)

// 4. If searchMethod === 'users':
//    a. Create user: createUser(personName) → userId
//    b. Associate faces: associateFaces(userId, faceIds)
//    c. Store userId: updatePersonUserId(person.id, userId)
```

Need to track faceIds during indexing (currently discarded after logging).

### 5. Scanner Changes (`src/pipeline/scanner.ts`)

Update `processPhotoItem()` to use configured search method:

```typescript
// Check config and use appropriate method:
const matches = config.rekognition.searchMethod === 'users'
  ? await this.client.searchUsers(photo.path)
  : await this.client.searchFaces(photo.path);
```

Both methods return compatible structures (can normalize `UserMatch` to `FaceMatch` format).

### 6. Status Command Changes (`src/commands/status.ts`)

Add user count to collection info display.

### 7. Recognition Schema Changes (`src/db/index.ts`)

Track search method per recognition for stats comparison:

```typescript
export interface Recognition {
  personId: number;
  personName: string;
  confidence: number;
  faceId: string;
  boundingBox: BoundingBox;
  searchMethod: 'faces' | 'users';  // NEW: track which method found this
}
```

### 8. Stats Command Changes (`src/commands/stats.ts`)

Display both overall and per-method accuracy:

```
Classification Accuracy

Overall:
  Precision: 87.2%  (approved / (approved + rejected))
  Photos reviewed: 1,500

By Search Method:
  faces:   84.1%  (1,000 photos)
  users:   92.8%  (500 photos)

By Person:
  Mom:     91.2%  [████████████░░] 156 photos
  Dad:     88.5%  [███████████░░░] 89 photos
```

This allows users to compare method effectiveness on their specific data.

**Migration note:** Existing recognitions without `searchMethod` default to `'faces'` (the only method available before this feature).

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/config.ts` | Add `searchMethod: 'faces' \| 'users'` to rekognition schema |
| `src/db/index.ts` | Add `user_id` column, `userId` to Person, `searchMethod` to Recognition |
| `src/rekognition/client.ts` | Add `createUser()`, `associateFaces()`, `searchUsers()`, `listUsers()`, `deleteUser()` |
| `src/rekognition/types.ts` | Add `UserMatch` interface |
| `src/commands/train.ts` | Collect faceIds, conditionally create users when `searchMethod: users` |
| `src/pipeline/scanner.ts` | Check config, use appropriate search method, validate mode match, store searchMethod in recognitions |
| `src/commands/status.ts` | Display user count (when using user vectors) |
| `src/commands/stats.ts` | Add per-method accuracy breakdown |
| `docs/Architecture.md` | Document both search methods |

---

## AWS API Reference

### CreateUserCommand
```typescript
await client.send(new CreateUserCommand({
  CollectionId: collectionId,
  UserId: `user_${personName.toLowerCase().replace(/\s+/g, '_')}`,
}));
```

### AssociateFacesCommand
```typescript
await client.send(new AssociateFacesCommand({
  CollectionId: collectionId,
  UserId: userId,
  FaceIds: faceIds,  // Array of face IDs from IndexFaces
}));
```

### SearchUsersByImageCommand
```typescript
const response = await client.send(new SearchUsersByImageCommand({
  CollectionId: collectionId,
  Image: { Bytes: imageBytes },
  MaxUsers: maxUsers,
  UserMatchThreshold: minConfidence,
}));
```

---

## Design Decisions

1. **Dual-mode support** → Both methods permanently available via `searchMethod` config
2. **User ID format** → `user_${name}` (readable, sanitized: lowercase, spaces to underscores)
3. **Face association limit** → Warn if person has >100 reference photos (AWS limit)
4. **Re-training behavior** → Delete old user and recreate (simple, matches current face indexing behavior)
