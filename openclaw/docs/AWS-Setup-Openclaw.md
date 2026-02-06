# AWS IAM Setup for Openclaw Agent

This guide configures restricted AWS Rekognition access for the "openclaw" AI agent.

## Overview

The openclaw agent needs access to:
- Read collection status and metadata
- Train (index faces, create users)
- Scan photos (search for face matches)
- Initialize new collections

The agent CANNOT:
- Delete the Rekognition collection (data loss protection)
- Access other AWS services
- Access collections outside the `openbook-*` naming pattern

## Prerequisites

- AWS account with IAM admin access
- AWS CLI configured (optional, for testing)
- openbook project initialized (`openbook init` already run)

## Step-by-Step Setup

### 1. Create IAM Policy

**Via AWS Console:**

1. Log into AWS Console → IAM → Policies → Create Policy
2. Click "JSON" tab
3. Paste the policy from `iam/openclaw-rekognition-policy.json`
4. Click "Next"
5. Set policy name: `OpenbookRekognitionRestrictedAccess`
6. Set description: `Restricted Rekognition access for openclaw agent - allows training and scanning, denies collection deletion`
7. Click "Create policy"

**Via AWS CLI:**
```bash
aws iam create-policy \
  --policy-name OpenbookRekognitionRestrictedAccess \
  --policy-document file://iam/openclaw-rekognition-policy.json \
  --description "Restricted Rekognition access for openclaw agent"
```

### 2. Create IAM User

**Via AWS Console:**

1. AWS Console → IAM → Users → Create User
2. Username: `openclaw-agent`
3. Select "Access key - Programmatic access"
4. Click "Next"
5. Select "Attach policies directly"
6. Search for `OpenbookRekognitionRestrictedAccess`
7. Check the policy
8. Click "Next" → "Create user"

**Via AWS CLI:**
```bash
aws iam create-user --user-name openclaw-agent

aws iam attach-user-policy \
  --user-name openclaw-agent \
  --policy-arn arn:aws:iam::YOUR_ACCOUNT_ID:policy/OpenbookRekognitionRestrictedAccess
```

### 3. Generate Access Keys

**Via AWS Console:**

1. AWS Console → IAM → Users → openclaw-agent
2. Security credentials tab
3. Click "Create access key"
4. Select "Application running outside AWS"
5. Click "Next"
6. (Optional) Add description tag: `openbook-openclaw-agent`
7. Click "Create access key"
8. **IMPORTANT**: Copy both Access Key ID and Secret Access Key
9. Store securely (this is the only time you'll see the secret key)

**Via AWS CLI:**
```bash
aws iam create-access-key --user-name openclaw-agent
```

Save the output securely:
```json
{
  "AccessKey": {
    "AccessKeyId": "AKIA...",
    "SecretAccessKey": "wJalrXUtn...",
    "Status": "Active"
  }
}
```

### 4. Configure Openbook

Create a separate environment file for openclaw: `.env.openclaw`

```bash
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=wJalrXUtn...
AWS_REGION=us-east-1
```

Or export directly in the openclaw agent's environment:
```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=wJalrXUtn...
export AWS_REGION=us-east-1
```

### 5. Verify Configuration

Test that the credentials work and restrictions are enforced:

```bash
# Should work: Check status
openbook status

# Should work: Train on references
openbook train ./references

# Should work: Scan photos
openbook scan ./test-photos

# Should FAIL: Try to delete collection
openbook cleanup --yes
# Expected error: "User: arn:aws:iam::ACCOUNT:user/openclaw-agent is not authorized to perform: rekognition:DeleteCollection"
```

## Verification Tests

### Test 1: Read Operations
```bash
openbook status
```
**Expected**: Shows collection info, face counts, user counts

### Test 2: Training Operations
```bash
openbook train ./references
```
**Expected**: Successfully indexes faces and creates user (if searchMethod: users)

### Test 3: Scanning Operations
```bash
openbook scan ./test-photos --dry-run
```
**Expected**: Successfully searches for face matches

### Test 4: Destructive Operations (Should Fail)
```bash
openbook cleanup --yes
```
**Expected**: AWS error with "AccessDenied" or "not authorized to perform: rekognition:DeleteCollection"

### Test 5: Collection Creation (Should Work)
```bash
# Only if you need to test collection creation
# First, manually delete the collection with admin credentials
openbook init
```
**Expected**: Successfully creates collection

## Security Considerations

### What This Policy Protects

1. **Data Loss Protection**: Cannot delete the face collection (years of training data)
2. **Scope Limitation**: Only works with collections matching `openbook-*`
3. **Service Isolation**: No access to other AWS services (S3, EC2, etc.)
4. **Collection Isolation**: Cannot access other Rekognition collections

### What This Policy Allows

1. **DeleteUser**: Required for training workflow
   - Called during `openbook train` to ensure clean user associations
   - Only deletes user metadata, not face vectors
   - Face vectors remain indexed and can be re-associated

2. **CreateCollection**: Required for initialization
   - Only works if collection doesn't exist
   - Follows naming pattern `openbook-*`

### Key Limitations

1. **No MFA**: Long-term access keys don't support MFA
2. **No Rotation Reminder**: Consider rotating keys every 90 days
3. **Broad Region Access**: Policy allows all regions (use * in ARN)

### Recommended Additional Hardening

If desired, add these optional restrictions:

**1. Limit to specific region:**
```json
"Resource": "arn:aws:rekognition:us-east-1:YOUR_ACCOUNT_ID:collection/openbook-*"
```

**2. Limit to exact collection name:**
```json
"Resource": "arn:aws:rekognition:*:YOUR_ACCOUNT_ID:collection/openbook-faces"
```

**3. Add IP restriction (if openclaw runs from known IPs):**
```json
{
  "Condition": {
    "IpAddress": {
      "aws:SourceIp": ["203.0.113.0/24"]
    }
  }
}
```

**4. Add time-based access:**
```json
{
  "Condition": {
    "DateGreaterThan": {"aws:CurrentTime": "2024-01-01T00:00:00Z"},
    "DateLessThan": {"aws:CurrentTime": "2024-12-31T23:59:59Z"}
  }
}
```

## Troubleshooting

### Error: "User is not authorized to perform rekognition:SearchFacesByImage"

**Cause**: Policy not attached or collection name doesn't match pattern

**Solution**:
1. Verify policy is attached: `aws iam list-attached-user-policies --user-name openclaw-agent`
2. Check collection name in `config.yaml` matches `openbook-*` pattern
3. Verify you're using the correct AWS region

### Error: "ResourceNotFoundException: Collection not found"

**Cause**: Collection doesn't exist or wrong collection ID

**Solution**:
1. Run `openbook init` with admin credentials
2. Verify `config.yaml` has correct `collectionId: openbook-faces`
3. Check status with admin credentials: `openbook status`

### Training Works But User Creation Fails

**Cause**: Policy might not include `CreateUser` or `AssociateFaces`

**Solution**:
1. Verify policy includes all training actions
2. Check `config.yaml` has `searchMethod: users` if you expect user creation
3. Review CloudTrail logs for specific denied actions

### DeleteUser Fails During Training

**Cause**: Missing `DeleteUser` permission (edge case if policy was modified)

**Solution**:
1. Verify policy includes `rekognition:DeleteUser` in training statement
2. This is required for clean re-training workflows

## Monitoring and Audit

### Track Usage with CloudTrail

Enable CloudTrail to monitor openclaw's Rekognition usage:

1. AWS Console → CloudTrail → Create trail
2. Filter by: `userIdentity.userName = "openclaw-agent"`
3. Monitor for:
   - Unexpected API calls
   - High volume usage
   - Failed authorization attempts

### Cost Monitoring

Set up billing alerts for Rekognition:

1. AWS Console → Billing → Budgets
2. Create budget for Rekognition service
3. Set alert threshold (e.g., $10/month)

### Usage Limits

AWS Rekognition default limits (per account):
- Max collections: 100
- Max faces per collection: 20 million
- API rate limit: 5 TPS (transactions per second)

openbook's rate limiting (configured in `config.yaml`):
- Default: 5 requests/second
- Max concurrent: 5

## Credential Lifecycle

### Rotation Schedule

Recommended: Rotate access keys every 90 days

**Rotation Process:**
1. Generate new access key for openclaw-agent
2. Update openclaw's environment configuration
3. Test with new credentials
4. Deactivate old access key
5. Wait 7 days (grace period)
6. Delete old access key

### Revocation

If credentials are compromised:

```bash
# Immediately deactivate the access key
aws iam update-access-key \
  --user-name openclaw-agent \
  --access-key-id AKIA... \
  --status Inactive

# Delete the access key
aws iam delete-access-key \
  --user-name openclaw-agent \
  --access-key-id AKIA...

# Generate new credentials
aws iam create-access-key --user-name openclaw-agent
```

## Quick Setup Script

For automated setup, use the provided script:

```bash
./scripts/setup-openclaw-iam.sh
```

This will:
1. Create the IAM policy
2. Create the IAM user
3. Attach the policy
4. Generate access keys
5. Display credentials for configuration

## References

- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [AWS Rekognition API Reference](https://docs.aws.amazon.com/rekognition/latest/APIReference/)
- [Openbook Architecture](./Architecture.md)
- [IAM Policy Testing Checklist](../tests/iam-policy-test.md)
