#!/usr/bin/env bash
set -euo pipefail
# Single-file ESM bundle of the CLI so a plugin install needs no pnpm install.
esbuild bin/cc-recall.ts --bundle --platform=node --format=esm --target=node22 \
  --outfile=dist/bin/cc-recall.js \
  --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"
