#!/bin/sh
# Copies the static game from web/ into docs/ so GitHub Pages (Settings > Pages > main /docs) can serve it.
# Run from the repo root after changing anything in web/, then commit docs/.
set -e
rm -rf docs/play
mkdir -p docs/play
cp -R web/. docs/play/
touch docs/.nojekyll
