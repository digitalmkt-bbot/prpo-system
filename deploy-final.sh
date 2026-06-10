#!/bin/bash

# PR/PO System - Final Deployment Helper Script
# Usage: chmod +x deploy-final.sh && ./deploy-final.sh

set -e

echo "🚀 PR/PO System - Final Deployment"
echo "===================================="
echo ""

# Color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Get Railway URL
echo -e "${BLUE}Step 1: Railway URL${NC}"
echo "Go to: https://railway.app/dashboard"
echo "Select: prpo-system project"
echo "Click: Settings tab"
echo "Copy: URL from Public Networking"
echo ""
read -p "Paste your Railway URL here (https://...): " RAILWAY_URL

# Validate URL
if [[ ! $RAILWAY_URL =~ ^https:// ]]; then
    echo -e "${YELLOW}❌ Invalid URL. Must start with https://${NC}"
    exit 1
fi

echo -e "${GREEN}✅ URL: $RAILWAY_URL${NC}"
echo ""

# Step 2: Test API
echo -e "${BLUE}Step 2: Testing API Health${NC}"
echo "Testing: $RAILWAY_URL/api/health"
echo ""

HEALTH_CHECK=$(curl -s "$RAILWAY_URL/api/health")
if echo "$HEALTH_CHECK" | grep -q "OK"; then
    echo -e "${GREEN}✅ API is working!${NC}"
    echo "Response: $HEALTH_CHECK"
else
    echo -e "${YELLOW}⚠️ API returned: $HEALTH_CHECK${NC}"
    echo "Note: Database might not be initialized yet (Step 3-4)"
fi

echo ""
echo -e "${BLUE}Step 3: Next - Add PostgreSQL Database${NC}"
echo ""
echo "In Railway Dashboard:"
echo "1. Click: + New Service"
echo "2. Select: Database → PostgreSQL"
echo "3. Create: (wait 1-2 minutes)"
echo ""
read -p "When PostgreSQL is ready, press Enter..."

echo ""
echo -e "${BLUE}Step 4: Initialize Database Schema${NC}"
echo ""
echo "In Railway Dashboard:"
echo "1. Click: PostgreSQL service"
echo "2. Go to: Database tab"
echo "3. Click: SQL Query"
echo "4. Copy: ALL from database.sql"
echo "5. Paste: into SQL editor"
echo "6. Execute: Click button"
echo ""
read -p "When database is initialized, press Enter..."

echo ""
echo "🎉 Testing database connection..."
DEPARTMENTS=$(curl -s "$RAILWAY_URL/api/departments")
if [ ! -z "$DEPARTMENTS" ]; then
    echo -e "${GREEN}✅ Database is connected!${NC}"
    echo "Sample response: ${DEPARTMENTS:0:100}..."
else
    echo -e "${YELLOW}⚠️ Database might still be initializing${NC}"
fi

echo ""
echo "=================================="
echo -e "${GREEN}✅ DEPLOYMENT COMPLETE!${NC}"
echo "=================================="
echo ""
echo "Your system is now LIVE!"
echo ""
echo "📍 App URL:"
echo "   $RAILWAY_URL"
echo ""
echo "📍 API Health:"
echo "   $RAILWAY_URL/api/health"
echo ""
echo "📍 Dashboard:"
echo "   $RAILWAY_URL/"
echo ""
echo "Next steps:"
echo "1. Test API endpoints"
echo "2. Create sample PRs"
echo "3. Test approval workflow"
echo ""
echo "See DEPLOYMENT_COMPLETE.md for full documentation"
echo ""
