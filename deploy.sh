#!/bin/bash
set -e

echo "🚀 Cloudflare Memory MCP Deployment Script"
echo "=========================================="
echo ""

if [ -z "$SHARED_PASSWORD" ]; then
    echo "❌ SHARED_PASSWORD is not set."
    echo "   Export it before running this script, for example:"
    echo "   export SHARED_PASSWORD='choose-a-long-random-password'"
    exit 1
fi

# Check if logged in
echo "Checking Cloudflare authentication..."
if ! wrangler whoami &>/dev/null; then
    echo "❌ Not logged in. Please run: wrangler login"
    echo "   This will open a browser for authentication."
    exit 1
fi
echo "✅ Authenticated with Cloudflare"
echo ""

# Create OAuth KV Namespace if config still has placeholder
if grep -q '00000000000000000000000000000000' wrangler.jsonc; then
    echo "🔐 Creating OAuth KV namespace 'cloudflare-memory-mcp-oauth'..."
    wrangler kv namespace create cloudflare-memory-mcp-oauth --binding OAUTH_KV --update-config
    echo "✅ OAuth KV namespace ready"
    echo ""
fi

# Create D1 Database
echo "📦 Creating D1 database 'cloudflare-memory-mcp'..."
DB_OUTPUT=$(wrangler d1 create cloudflare-memory-mcp 2>&1 || true)

# Extract database ID if creation succeeded or already exists
if echo "$DB_OUTPUT" | grep -q "database_id\|already exists"; then
    if echo "$DB_OUTPUT" | grep -q "database_id"; then
        DB_ID=$(echo "$DB_OUTPUT" | grep -oP '(?<=database_id = ")[^"]+')
        echo "✅ D1 database created: $DB_ID"
    else
        # Database might already exist, try to get info
        DB_INFO=$(wrangler d1 list --json 2>/dev/null | grep -A5 '"name": "cloudflare-memory-mcp"' || true)
        if [ -n "$DB_INFO" ]; then
            DB_ID=$(echo "$DB_INFO" | grep -oP '(?<="uuid": ")[^"]+' | head -1)
            echo "✅ Using existing D1 database: $DB_ID"
        fi
    fi
else
    echo "⚠️  D1 creation output:"
    echo "$DB_OUTPUT"
fi

# Create Vectorize Index
echo ""
echo "🔍 Creating Vectorize index 'cloudflare-memory-index'..."
VECTOR_OUTPUT=$(wrangler vectorize create cloudflare-memory-index \
    --dimensions=768 \
    --metric=cosine \
    2>&1 || true)

if echo "$VECTOR_OUTPUT" | grep -q "Successfully created\|already exists"; then
    echo "✅ Vectorize index ready"
else
    echo "⚠️  Vectorize output:"
    echo "$VECTOR_OUTPUT"
fi

# Update wrangler.jsonc with real DB ID if we got one
if [ -n "$DB_ID" ] && [ "$DB_ID" != "00000000-0000-0000-0000-000000000000" ]; then
    echo ""
    echo "📝 Updating wrangler.jsonc with database ID: $DB_ID"
    sed -i "s/00000000-0000-0000-0000-000000000000/$DB_ID/g" wrangler.jsonc
    echo "✅ Updated wrangler.jsonc"
fi

# Apply D1 migrations
echo ""
echo "🗄️  Applying D1 migrations..."
wrangler d1 migrations apply cloudflare-memory-mcp --local=false || true

# Update Worker Secret
echo ""
echo "🔒 Updating SHARED_PASSWORD worker secret..."
printf '%s' "$SHARED_PASSWORD" | wrangler secret put SHARED_PASSWORD

# Deploy
echo ""
echo "🚀 Deploying Worker..."
wrangler deploy

# Get deployed URL
echo ""
echo "🎉 Deployment complete!"
wrangler info 2>/dev/null | grep -E "URL|worker" || true
