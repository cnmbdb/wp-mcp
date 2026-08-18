#!/bin/sh
set -eu

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Fill in WP_URL and credentials, then run ./deploy.sh again."
  exit 1
fi

if grep -q 'WP_URL=https://example.com' .env; then
  echo "Refusing to start with the placeholder WP_URL. Edit .env first."
  exit 1
fi

docker compose pull
docker compose up -d
docker compose ps
echo "Health: http://127.0.0.1:${PORT:-3000}/health"
echo "MCP:    http://127.0.0.1:${PORT:-3000}/mcp"
