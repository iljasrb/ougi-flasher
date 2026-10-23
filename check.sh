#!/usr/bin/env bash
# Static checks before deploying: syntax, undefined identifiers, unlock detection.
#
#   ./check.sh
set -eu
cd "$(dirname "$0")"
files=(app.js console.js tools.js lib/*.mjs lib/chrome.js zip.mjs)
globals=(document window navigator location crypto Blob URL URLSearchParams Response ReadableStream TransformStream DecompressionStream
	TextDecoder TextEncoder fetch setTimeout clearTimeout setInterval clearInterval URL console indexedDB localStorage)

for f in "${files[@]}"; do
	cp "$f" .check.mjs
	node --check .check.mjs
done
rm -f .check.mjs

node check-unlock.mjs
node check-sideload.mjs
node check-paths.mjs
node check-images.mjs

# no-undef is what catches a helper that was deleted or renamed but is still called.
args=()
for g in "${globals[@]}"; do args+=(--global "$g"); done
npx --yes eslint@9 --no-config-lookup --rule '{"no-undef":"error"}' "${args[@]}" "${files[@]}"
echo "ok — js"
