#!/bin/bash
set -e

echo "🚀 Cloudflare Memory MCP Deployment Script"
echo "=========================================="
echo ""

# Check if logged in
echo "Checking Cloudflare authentication..."
if ! wrangler whoami &>/dev/null; then
    echo "❌ Not logged in. Please run: wrangler login"
    echo "   This will open a browser for authentication."
    exit 1
fi
echo "✅ Authenticated with Cloudflare"
echo ""

# Create D1 Database
echo "📦 Creating D1 database 'cloudflare-memory-mcp'..."
DB_OUTPUT=$(wrangler d1 create cloudflare-memory-mcp 2>&1 || true)

if echo "$DB_OUTPUT" | grep -q "database_id\|already exists"; then
    echo "✅ D1 database ready"
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

# Apply D1 migrations
echo ""
echo "🗄️  Applying D1 migrations..."
wrangler d1 migrations apply cloudflare-memory-mcp --local=false || true

# Deploy
echo ""
echo "🚀 Deploying Worker..."
wrangler deploy

# Get deployed URL
echo ""
echo "🎉 Deployment complete!"
wrangler info 2>/dev/null | grep -E "URL|worker" || true
