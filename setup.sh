#!/usr/bin/env bash
set -euo pipefail

# The Unnamed Town — Quick Setup
# Usage: ./setup.sh [--docker]

DOCKER_MODE=false
if [[ "${1:-}" == "--docker" ]]; then
  DOCKER_MODE=true
fi

echo ""
echo "=== The Unnamed Town ==="
echo "LLM-powered text adventure with autonomous NPCs"
echo ""

# 1. Check prerequisites
if [[ "$DOCKER_MODE" == true ]]; then
  if ! command -v docker &>/dev/null; then
    echo "Error: docker is required for --docker mode. Install from https://docker.com"
    exit 1
  fi
  if ! command -v docker compose &>/dev/null && ! docker compose version &>/dev/null 2>&1; then
    echo "Error: docker compose is required. Install Docker Desktop or the compose plugin."
    exit 1
  fi
else
  if ! command -v node &>/dev/null; then
    echo "Error: Node.js is required. Install from https://nodejs.org (v20+)"
    exit 1
  fi
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_MAJOR" -lt 20 ]]; then
    echo "Error: Node.js 20+ required (found $(node -v))"
    exit 1
  fi
fi

# 2. Create .env if missing
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

# 3. Check for API key
CURRENT_KEY=$(grep -oP '(?<=OPENAI_API_KEY=).*' .env 2>/dev/null || true)
if [[ -z "$CURRENT_KEY" || "$CURRENT_KEY" == "your-openai-api-key-here" ]]; then
  echo ""
  echo "An OpenAI API key is required (https://platform.openai.com/api-keys)"
  echo "Cost: ~\$0.30 for world generation, ~\$0.15-0.30/hour gameplay"
  echo ""
  read -rp "Paste your OpenAI API key: " API_KEY
  if [[ -z "$API_KEY" ]]; then
    echo "Error: API key is required"
    exit 1
  fi
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|OPENAI_API_KEY=.*|OPENAI_API_KEY=${API_KEY}|" .env
  else
    sed -i "s|OPENAI_API_KEY=.*|OPENAI_API_KEY=${API_KEY}|" .env
  fi
  echo "API key saved to .env"
fi

# 4. Launch
echo ""
if [[ "$DOCKER_MODE" == true ]]; then
  echo "Starting with Docker (production mode)..."
  echo "This will build containers on first run (~2-3 min)"
  echo ""
  docker compose up --build
else
  echo "Installing dependencies..."
  npm install --silent
  echo ""
  echo "Starting dev server..."
  echo "  Frontend: http://localhost:5173"
  echo "  Backend:  http://localhost:3001"
  echo ""
  npm run dev
fi
