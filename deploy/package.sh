#!/usr/bin/env bash
# Builds deploy/railradar.tgz: the app plus the prebuilt rail network (no node_modules, no caches).
set -euo pipefail
cd "$(dirname "$0")/.."
tar czf deploy/railradar.tgz \
  package.json package-lock.json README.md Dockerfile docker-compose.yml .dockerignore \
  server shared scripts web deploy/setup-nginx.sh deploy/package.sh \
  data/rail-graph.json
ls -la deploy/railradar.tgz
