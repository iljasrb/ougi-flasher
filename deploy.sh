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
printf '%s\n' "$version" > version.txt
rsync -a --delete \
	--exclude .git \
	--exclude '*.zip' \
	--exclude 'bronco/' \
	--exclude 'pkg/' \
	--exclude node_modules \
	--exclude 'check*' \
	--exclude '_probe*' \
	./ "$dest/"
rm -f version.txt
echo "deployed $version -> $dest"
