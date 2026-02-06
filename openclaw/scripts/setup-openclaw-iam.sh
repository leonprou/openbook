#!/bin/bash
set -e

# Script to automate openclaw IAM user creation
# Usage: ./scripts/setup-openclaw-iam.sh

POLICY_NAME="OpenbookRekognitionRestrictedAccess"
USER_NAME="openclaw-agent"
POLICY_FILE="iam/openclaw-rekognition-policy.json"

echo "Setting up IAM user for openclaw agent..."
echo ""

# Check if policy file exists
if [ ! -f "$POLICY_FILE" ]; then
  echo "Error: Policy file not found: $POLICY_FILE"
  exit 1
fi

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "AWS Account ID: $ACCOUNT_ID"
echo ""

# Create policy
echo "Creating IAM policy..."
POLICY_ARN=$(aws iam create-policy \
  --policy-name "$POLICY_NAME" \
  --policy-document "file://$POLICY_FILE" \
  --description "Restricted Rekognition access for openclaw agent" \
  --query 'Policy.Arn' \
  --output text 2>/dev/null || echo "exists")

if [ "$POLICY_ARN" = "exists" ]; then
  POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/$POLICY_NAME"
  echo "Policy already exists: $POLICY_ARN"
else
  echo "Policy created: $POLICY_ARN"
fi
echo ""

# Create user
echo "Creating IAM user..."
aws iam create-user --user-name "$USER_NAME" 2>/dev/null && echo "User created: $USER_NAME" || echo "User already exists: $USER_NAME"
echo ""

# Attach policy
echo "Attaching policy to user..."
aws iam attach-user-policy \
  --user-name "$USER_NAME" \
  --policy-arn "$POLICY_ARN"
echo "Policy attached successfully"
echo ""

# Create access key
echo "Creating access key..."
ACCESS_KEY_OUTPUT=$(aws iam create-access-key --user-name "$USER_NAME" --output json)

echo ""
echo "=========================================="
echo "Setup complete!"
echo "=========================================="
echo ""
echo "Access Key ID:"
echo "$(echo "$ACCESS_KEY_OUTPUT" | jq -r '.AccessKey.AccessKeyId')"
echo ""
echo "Secret Access Key:"
echo "$(echo "$ACCESS_KEY_OUTPUT" | jq -r '.AccessKey.SecretAccessKey')"
echo ""
echo "Add these to your environment:"
echo ""
echo "export AWS_ACCESS_KEY_ID=$(echo "$ACCESS_KEY_OUTPUT" | jq -r '.AccessKey.AccessKeyId')"
echo "export AWS_SECRET_ACCESS_KEY=$(echo "$ACCESS_KEY_OUTPUT" | jq -r '.AccessKey.SecretAccessKey')"
echo "export AWS_REGION=us-east-1"
echo ""
echo "Or create .env.openclaw file with:"
echo "AWS_ACCESS_KEY_ID=$(echo "$ACCESS_KEY_OUTPUT" | jq -r '.AccessKey.AccessKeyId')"
echo "AWS_SECRET_ACCESS_KEY=$(echo "$ACCESS_KEY_OUTPUT" | jq -r '.AccessKey.SecretAccessKey')"
echo "AWS_REGION=us-east-1"
echo ""
echo "=========================================="
echo "IMPORTANT: Save these credentials securely."
echo "The secret key cannot be retrieved again."
echo "=========================================="
echo ""
