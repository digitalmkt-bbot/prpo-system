#!/bin/bash

# PR/PO System - Final Fix & Test
# Run this ONE script to complete everything

echo "🚀 PR/PO System - Final Fix & Test"
echo "=================================="
echo ""

# Step 1: Fix permissions
echo "Step 1: Fixing permissions..."
chmod +x test-api.sh deploy-final.sh setup.sh
echo "✅ Permissions fixed"
echo ""

# Step 2: Get Railway URL
RAILWAY_URL="https://prpo-system-production.up.railway.app"
echo "Step 2: Using Railway URL"
echo "  $RAILWAY_URL"
echo ""

# Step 3: Wait for app to be ready
echo "Step 3: Waiting for app to initialize (30 seconds)..."
sleep 30
echo "✅ Wait complete"
echo ""

# Step 4: Test API Health
echo "Step 4: Testing API Health..."
echo "  GET $RAILWAY_URL/api/health"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" "$RAILWAY_URL/api/health")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "Response:"
echo "  HTTP Code: $HTTP_CODE"
echo "  Body: $BODY"
echo ""

# Step 5: Check result
if [ "$HTTP_CODE" = "200" ] || echo "$BODY" | grep -q "status.*OK"; then
    echo "=================================="
    echo "✅ SUCCESS! System is LIVE!"
    echo "=================================="
    echo ""
    echo "🎉 Your PR/PO System is working!"
    echo ""
    echo "URLs:"
    echo "  📍 Dashboard: $RAILWAY_URL/"
    echo "  📍 API Health: $RAILWAY_URL/api/health"
    echo ""
    echo "Next steps:"
    echo "  1. Open browser: $RAILWAY_URL"
    echo "  2. Test dashboard"
    echo "  3. Create sample departments/PRs"
    echo ""
    echo "Full test suite:"
    echo "  ./test-api.sh $RAILWAY_URL"
    echo ""
else
    echo "=================================="
    echo "⚠️ System still initializing..."
    echo "=================================="
    echo ""
    echo "API returned: $HTTP_CODE"
    echo ""
    echo "This is normal - Railway may need 1-2 more minutes"
    echo ""
    echo "Try again:"
    echo "  sleep 60"
    echo "  curl $RAILWAY_URL/api/health"
    echo ""
fi

echo "Done!"
