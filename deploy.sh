#!/usr/bin/env bash
# Deploy the flasher: ./deploy.sh user@host:/path/under/the/webroot
#
# The path below is whatever directory the host serves <origin>/bronco/flasher from.
#
# Static files only. The page is served from the same origin as the packages
# (/bronco/latest/…), so no proxy or CORS entry is involved.
set -eu
dest=${1:?usage: $0 user@host:/path/under/the/webroot}
# the footer shows this, the same short hash meisho prints
version=$(git rev-parse --short HEAD 2>/dev/null || echo dev)

# Stage first: the CDN caches .css/.js for hours and there is no purge token, so every asset URL
# gets the commit as a query string. A deploy is then visible immediately instead of after the TTL.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
exclude=(--exclude .git --exclude '*.zip' --exclude 'bronco/' --exclude 'pkg/' --exclude node_modules --exclude 'check*' --exclude '_probe*')
rsync -a "${exclude[@]}" ./ "$stage/"
printf '%s\n' "$version" > "$stage/version.txt"
sed -i -E "s#(href=\"style\.css)\"#\1?v=$version\"#; s#(src=\"(app|console|tools)\.js)\"#\1?v=$version\"#" "$stage"/*.html
sed -i -E "s|from '(\.\.?/[^']*)'|from '\1?v=$version'|g" "$stage"/*.js "$stage"/lib/*.mjs "$stage"/lib/*.js "$stage"/zip.mjs

rsync -a --delete --delete-excluded "${exclude[@]}" "$stage/" "$dest/"
echo "deployed $version -> $dest"
