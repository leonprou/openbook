# Training Best Practices

Guide for building an effective face recognition training set.

## Quickstart

Get training working in 5 minutes:

```bash
# 1. Create reference folders (one per person)
mkdir -p references/Mom references/Dad references/Sister

# 2. Add 5-10 clear photos per person
cp ~/Photos/mom-portrait.jpg references/Mom/
cp ~/Photos/mom-outdoor.jpg references/Mom/
# ... repeat for each person

# 3. Run training
openbook train

# 4. Verify it worked
openbook status
```

**Tips for quick success:**
- Use clear, front-facing photos where the face is prominent
- One person per photo (avoid group shots)
- Mix indoor and outdoor shots if possible

---

## Core Principle

**Quality over quantity.** AWS Rekognition creates face embeddings for each indexed photo. More photos isn't always better—a diverse, high-quality set outperforms a large, redundant one.

## Recommended Training Set

**10-20 diverse, high-quality photos per person.**

This provides enough variety for accurate matching without introducing noise or hitting diminishing returns.

## Building a Diverse Training Set

Prioritize diversity across these dimensions:

| Dimension | Examples |
|-----------|----------|
| **Lighting** | Indoor, outdoor, flash, natural light, low light |
| **Angles** | Front-facing, 3/4 profile, slight tilts |
| **Expressions** | Neutral, smiling, serious, laughing |
| **Ages** | Childhood, teen, adult, recent photos |
| **Context** | Formal, casual, different hairstyles/glasses |

## Diminishing Returns

Adding more photos has decreasing benefits:

```
Photos     Recognition Benefit
───────────────────────────────
1-5        Huge improvement
5-15       Strong improvement   ← Sweet spot
15-30      Moderate gains
30+        Minimal benefit, potential noise
```

## Photo Selection Checklist

For each person, try to include:

- [ ] 2-3 well-lit front-facing shots
- [ ] 1-2 profile or angled shots
- [ ] 1-2 with different expressions
- [ ] 1-2 from different time periods (if available)
- [ ] 1-2 in different contexts (indoor/outdoor)
- [ ] With and without glasses (if applicable)

## When to Retrain

### Yes, add new training photos when:

- Person's appearance changed significantly (age, weight, hairstyle)
- You're getting frequent false negatives for that person
- You found photos in conditions not covered (e.g., new glasses, beard)
- Recognition confidence is consistently low

### No, don't bother when:

- You just found more similar photos
- Current recognition is working well
- Photos are low quality or redundant
- Person is already well-represented in training set

## Retraining Workflow

```bash
# 1. Check current recognition performance
openbook photos --status pending --person "Mom"

# 2. If many missed photos, add diverse samples
cp new-photos/* references/Mom/

# 3. Retrain
openbook train

# 4. Rescan to apply new training
openbook scan --rescan
```

## Anti-Patterns to Avoid

| Don't | Why |
|-------|-----|
| Train on blurry or distant photos | Poor face detection quality |
| Use photos with sunglasses/masks | Occlusions reduce accuracy |
| Add 50+ photos per person | Diminishing returns, adds noise |
| Use group photos | Multiple faces cause confusion |
| Never update training | Recognition degrades as people age |
| Use only one type of photo | Fails to match diverse conditions |

## Folder Structure

Organize reference photos with one folder per person:

```
references/
├── Mom/
│   ├── portrait-2020.jpg
│   ├── outdoor-smile.jpg
│   ├── profile-shot.jpg
│   └── childhood.jpg
├── Dad/
│   ├── formal.jpg
│   └── casual-outdoor.jpg
└── Sister/
    ├── recent.jpg
    └── teen-photo.jpg
```

The folder name becomes the person identifier used in matching and album names.

## Troubleshooting

### "No face detected" during training

- Try a different photo with better lighting
- Ensure face is clearly visible and not too small
- Avoid photos where face is partially obscured

### Low confidence matches during scanning

- Add more diverse training photos
- Check if training photos match the conditions in your library
- Consider adding photos from the same time period as your library

### Frequent false positives

- Remove low-quality training photos
- Ensure only one person per training photo
- Increase `minConfidence` threshold in config.yaml
