# Files to Upload to Openclaw EC2 Instance

## Method 1: Using rsync (Recommended)

```bash
# From your local machine, run:
rsync -av --exclude-from=.rsyncignore \
  ~/workspace/agents/openbook/ \
  ubuntu@ip-172-31-3-63:~/openbook/
```

## Method 2: Create Archive and Upload

```bash
# On local machine - create tarball excluding unnecessary files
tar -czf openbook-deploy.tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='*.db' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='config.yaml' \
  --exclude='references' \
  --exclude='.env*' \
  --exclude='.openbook-*.json' \
  --exclude='.claude' \
  --exclude='bun.lockb' \
  src/ \
  docs/ \
  iam/ \
  scripts/ \
  tests/ \
  package.json \
  tsconfig.json \
  bun.lock \
  config.example.yaml \
  README.md \
  CLAUDE.md \
  LICENSE

# Upload to EC2
scp openbook-deploy.tar.gz ubuntu@ip-172-31-3-63:~/

# On EC2 - extract
cd ~
tar -xzf openbook-deploy.tar.gz
```

## Files/Folders to Include

### Essential Source Code
- ✅ `src/` - All TypeScript source code
- ✅ `package.json` - Dependencies
- ✅ `tsconfig.json` - TypeScript config
- ✅ `bun.lock` - Dependency lock file

### Documentation
- ✅ `README.md` - User guide
- ✅ `CLAUDE.md` - Developer guide
- ✅ `docs/` - All documentation
- ✅ `LICENSE` - License file
- ✅ `CODE_OF_CONDUCT.md` - Code of conduct
- ✅ `CONTRIBUTING.md` - Contributing guide

### Configuration & Scripts
- ✅ `config.example.yaml` - Config template (rename to config.yaml on EC2)
- ✅ `iam/` - IAM policies (already used)
- ✅ `scripts/` - Setup scripts
- ✅ `tests/` - Test checklists

## Files/Folders to Exclude

### Auto-generated/Local Data
- ❌ `node_modules/` - Will reinstall with `bun install`
- ❌ `.openbook.db*` - Local database (will create new on EC2)
- ❌ `.openbook-review.json` - Local session data
- ❌ `.openbook-session.json` - Local session data
- ❌ `bun.lockb` - Binary lock file (not portable)

### Personal/Sensitive Data
- ❌ `config.yaml` - Contains local paths (use config.example.yaml)
- ❌ `references/` - Your personal reference photos
- ❌ `.env*` - Environment files with credentials
- ❌ `.claude/` - Local Claude Code settings

### Version Control & OS Files
- ❌ `.git/` - Not needed for deployment
- ❌ `.DS_Store` - macOS metadata
- ❌ `*.log` - Log files

## Setup Steps on EC2

After uploading files:

```bash
# 1. Navigate to openbook directory
cd ~/openbook

# 2. Install dependencies
bun install

# 3. Create config from template
cp config.example.yaml config.yaml

# 4. Edit config.yaml to set EC2-specific paths
nano config.yaml
# Update paths for EC2 environment

# 5. Credentials are already set (.env.openclaw exists)
source ~/.env.openclaw

# 6. Initialize openbook
bun run start init

# 7. Verify setup
bun run start status
```

## Quick Upload Commands

### Option A: Selective file upload
```bash
# Upload just the essentials
scp -r src/ ubuntu@ip-172-31-3-63:~/openbook/
scp -r docs/ ubuntu@ip-172-31-3-63:~/openbook/
scp -r scripts/ ubuntu@ip-172-31-3-63:~/openbook/
scp package.json tsconfig.json bun.lock config.example.yaml ubuntu@ip-172-31-3-63:~/openbook/
```

### Option B: Full directory sync (recommended)
```bash
# Create .rsyncignore file first (see below), then:
rsync -av --delete \
  --exclude-from=.rsyncignore \
  ~/workspace/agents/openbook/ \
  ubuntu@ip-172-31-3-63:~/openbook/
```

## .rsyncignore Contents

Create this file in your local openbook directory:

```
node_modules/
.git/
.openbook.db*
.openbook-*.json
config.yaml
references/
.env*
.claude/
*.log
.DS_Store
bun.lockb
dist/
*.swp
*.swo
```
