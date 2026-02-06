# IAM Policy Testing Checklist

## Setup

Before running tests, ensure you have:
- [ ] Created IAM user with restricted policy
- [ ] Generated access keys
- [ ] Configured openbook with restricted credentials:
  ```bash
  export AWS_ACCESS_KEY_ID=AKIA...
  export AWS_SECRET_ACCESS_KEY=wJalrXUtn...
  export AWS_REGION=us-east-1
  ```
- [ ] Verified `config.yaml` has collection ID matching `openbook-*` pattern

## Test Suite

### Test 1: Read Operations (Should Succeed)

**Command:**
```bash
openbook status
```

**Expected Result:**
- [ ] Shows collection info
- [ ] Displays face count
- [ ] Displays user count (if searchMethod: users)
- [ ] No access denied errors

**Actual Result:**
```
(Record your results here)
```

---

### Test 2: Training Operations (Should Succeed)

**Command:**
```bash
openbook train ./references
```

**Expected Result:**
- [ ] Successfully indexes faces
- [ ] CreateUser succeeds (if searchMethod: users)
- [ ] AssociateFaces succeeds (if searchMethod: users)
- [ ] DeleteUser succeeds during re-training (if user already exists)
- [ ] No access denied errors

**Actual Result:**
```
(Record your results here)
```

---

### Test 3: Scanning Operations (Should Succeed)

**Command:**
```bash
openbook scan ./test-photos --dry-run
```

**Expected Result:**
- [ ] Successfully searches for face matches
- [ ] SearchFacesByImage works (if searchMethod: faces)
- [ ] SearchUsersByImage works (if searchMethod: users)
- [ ] No access denied errors

**Actual Result:**
```
(Record your results here)
```

---

### Test 4: Collection Creation (Should Succeed)

**Prerequisites:**
- Collection must not exist (manually delete with admin credentials first)

**Command:**
```bash
openbook init
```

**Expected Result:**
- [ ] Successfully creates collection
- [ ] Collection name matches openbook-* pattern
- [ ] No access denied errors

**Actual Result:**
```
(Record your results here)
```

---

### Test 5: Destructive Operations (Should Fail)

**Command:**
```bash
openbook cleanup --yes
```

**Expected Result:**
- [ ] Returns AccessDenied error
- [ ] Error message contains: "not authorized to perform: rekognition:DeleteCollection"
- [ ] Collection is NOT deleted
- [ ] Command fails with non-zero exit code

**Actual Result:**
```
(Record your results here)
```

---

### Test 6: Resource Restrictions (Should Fail)

**Prerequisites:**
- Create a test collection with a different name pattern using admin credentials:
  ```bash
  aws rekognition create-collection --collection-id test-collection
  ```

**Command:**
```bash
# Try to describe a collection outside the openbook-* pattern
aws rekognition describe-collection --collection-id test-collection
```

**Expected Result:**
- [ ] Returns AccessDenied error
- [ ] Cannot access collections outside openbook-* pattern

**Actual Result:**
```
(Record your results here)
```

**Cleanup:**
```bash
# Delete test collection with admin credentials
aws rekognition delete-collection --collection-id test-collection
```

---

### Test 7: Service Restrictions (Should Fail)

**Test S3 Access:**
```bash
aws s3 ls
```

**Expected Result:**
- [ ] Returns AccessDenied error or "Unable to locate credentials"
- [ ] No S3 buckets listed

**Test EC2 Access:**
```bash
aws ec2 describe-instances
```

**Expected Result:**
- [ ] Returns AccessDenied error
- [ ] No EC2 instances listed

**Test IAM Access:**
```bash
aws iam list-users
```

**Expected Result:**
- [ ] Returns AccessDenied error
- [ ] No IAM users listed

**Actual Results:**
```
(Record your results here)
```

---

## Summary

### Tests Passed: ____ / 7

### Tests Failed: ____

### Issues Found:
- (List any issues or unexpected behavior)

---

## Additional Verification

### Check Attached Policies
```bash
aws iam list-attached-user-policies --user-name openclaw-agent
```

**Expected:**
- [ ] Shows `OpenbookRekognitionRestrictedAccess` policy attached

---

### Review CloudTrail Events (Optional)
```bash
# View recent Rekognition API calls by openclaw-agent
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=Username,AttributeValue=openclaw-agent \
  --max-results 20
```

**Check for:**
- [ ] Successful API calls match expected operations
- [ ] Failed API calls are only for denied operations (DeleteCollection)
- [ ] No unexpected API calls to other services

---

## Security Audit

- [ ] No credentials stored in git history
- [ ] `.env.openclaw` is in .gitignore
- [ ] Access keys are stored securely
- [ ] DeleteCollection is explicitly denied
- [ ] Resource ARNs restrict to openbook-* pattern
- [ ] No wildcard permissions for critical operations

---

## Notes

(Add any additional observations or recommendations)
