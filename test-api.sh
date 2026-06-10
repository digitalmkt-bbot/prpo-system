#!/bin/bash

# PR/PO System - API Testing Script
# Usage: ./test-api.sh https://your-railway-url

if [ -z "$1" ]; then
    echo "Usage: ./test-api.sh <RAILWAY_URL>"
    echo "Example: ./test-api.sh https://prpo-system-production.up.railway.app"
    exit 1
fi

RAILWAY_URL=$1

# Remove trailing slash if present
RAILWAY_URL="${RAILWAY_URL%/}"

# Color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}PR/PO System - API Test Suite${NC}"
echo "=================================="
echo "Testing: $RAILWAY_URL"
echo ""

# Function to test endpoint
test_endpoint() {
    local method=$1
    local endpoint=$2
    local description=$3

    echo -e "${BLUE}Testing: $description${NC}"
    echo "  $method $endpoint"

    if [ "$method" = "GET" ]; then
        RESPONSE=$(curl -s -w "\n%{http_code}" "$RAILWAY_URL$endpoint")
    else
        RESPONSE=$(curl -s -w "\n%{http_code}" -X "$method" "$RAILWAY_URL$endpoint" \
            -H "Content-Type: application/json")
    fi

    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
        echo -e "  ${GREEN}✅ HTTP $HTTP_CODE${NC}"
        echo "  Response: ${BODY:0:100}..."
    else
        echo -e "  ${RED}❌ HTTP $HTTP_CODE${NC}"
        echo "  Response: $BODY"
    fi
    echo ""
}

# Test endpoints
test_endpoint "GET" "/api/health" "Health Check"
test_endpoint "GET" "/api/prs" "List Purchase Requests"
test_endpoint "GET" "/api/departments" "List Departments"
test_endpoint "GET" "/api/suppliers" "List Suppliers"
test_endpoint "GET" "/api/products" "List Products"
test_endpoint "GET" "/api/approval-matrix" "List Approval Matrix"
test_endpoint "GET" "/api/pos" "List Purchase Orders"
test_endpoint "GET" "/api/company" "Get Company Info"
test_endpoint "GET" "/api/users" "List Users"

echo "=================================="
echo -e "${GREEN}✅ API Test Complete!${NC}"
echo ""
echo "If all endpoints returned HTTP 200/201:"
echo "  → Your system is working correctly ✅"
echo ""
echo "If some returned 500:"
echo "  → Database might not be initialized yet"
echo "  → Check DEPLOYMENT_COMPLETE.md Step 3-4"
echo ""
