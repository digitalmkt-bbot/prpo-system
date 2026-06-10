#!/bin/bash

# PR/PO System - Automated Setup Script
# For macOS and Linux

set -e  # Exit on error

echo "🚀 PR/PO Procurement System - Setup"
echo "===================================="
echo ""

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ Node.js/npm is not installed."
    echo "Please install from: https://nodejs.org"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"
echo "✅ npm version: $(npm --version)"
echo ""

# Check if files exist
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found"
    echo ""
    echo "📝 Make sure you're in the prpo-system folder with all files"
    echo ""
    exit 1
fi

echo "✅ Found package.json"
echo ""

# Install dependencies
echo "📦 Installing npm dependencies..."
echo ""
npm install

echo ""
echo "✅ npm install completed successfully"
echo ""

# Initialize git if not already done
if [ ! -d ".git" ]; then
    echo "🔧 Initializing git repository..."
    git init
    git add .
    git commit -m "Initial: PR/PO Procurement System on Node.js + Railway"
    echo "✅ Git repository initialized"
else
    echo "ℹ️  Git repository already exists"
fi

echo ""
echo "===================================="
echo "✅ SETUP COMPLETE!"
echo "===================================="
echo ""
echo "📝 Next steps:"
echo ""
echo "1️⃣  Create GitHub repository:"
echo "   Go to: https://github.com/new"
echo "   Name: prpo-system"
echo "   Click: Create Repository"
echo ""
echo "2️⃣  Push code to GitHub:"
echo "   git remote add origin https://github.com/YOUR_USERNAME/prpo-system.git"
echo "   git branch -M main"
echo "   git push -u origin main"
echo ""
echo "3️⃣  Deploy to Railway:"
echo "   npm install -g @railway/cli"
echo "   railway login"
echo "   railway init"
echo "   railway up"
echo ""
echo "4️⃣  Initialize Database:"
echo "   Copy database.sql content into Railway PostgreSQL console"
echo ""
echo "✨ Then you're LIVE! 🚀"
echo ""
