#!/bin/bash

echo "🚀 Pushing server.js fix to GitHub..."
echo ""

cd ~/Desktop/prpo-system

# Configure git (if needed)
git config user.email "nontiya@loveandaman.com" 2>/dev/null
git config user.name "Nontiya" 2>/dev/null

# Push
echo "Pushing to origin main..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Push successful!"
    echo ""
    echo "Railway will auto-redeploy in 30-60 seconds..."
    echo ""
    echo "Then run:"
    echo "  ./test-api.sh https://prpo-system-production.up.railway.app"
    echo ""
else
    echo "❌ Push failed. Check your Git credentials."
fi
