#!/usr/bin/env bash
# fetch-vendor.sh — materialize the pinned vendor sources for the FPC
# capture harness. Pins come from corpus/meta.json (single source of truth).
#
# Layout produced:
#   vendor/internettools   (benibela/internettools @ <pins.internettools.commit>)
#   vendor/FLRE            (benibela/FLRE           @ <pins.flre.commit>; src/ bundles PUCU)
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
META="$HARNESS_DIR/../meta.json"
VENDOR="$HARNESS_DIR/vendor"

IT_COMMIT="$(jq -r '.pins.internettools.commit' "$META")"
IT_REPO="$(jq -r '.pins.internettools.repo' "$META")"
FLRE_COMMIT="$(jq -r '.pins.flre.commit' "$META")"
FLRE_REPO="$(jq -r '.pins.flre.repo' "$META")"

fetch_pinned() {
  local repo="$1" commit="$2" dest="$3"
  echo "fetch-vendor: $repo @ $commit -> $dest"
  rm -rf "$dest.tmp"
  mkdir -p "$dest.tmp"
  git -C "$dest.tmp" init -q
  git -C "$dest.tmp" remote add origin "$repo"
  git -C "$dest.tmp" fetch -q --depth 1 origin "$commit"
  git -C "$dest.tmp" checkout -q FETCH_HEAD
  local got
  got="$(git -C "$dest.tmp" rev-parse HEAD)"
  if [ "$got" != "$commit" ]; then
    echo "fetch-vendor: FATAL fetched $got but pin is $commit" >&2
    rm -rf "$dest.tmp"
    exit 1
  fi
  rm -rf "$dest.tmp/.git"
  # pristine-source discipline: no compiled artifacts in the pinned tree
  find "$dest.tmp" -type f \( -name '*.ppu' -o -name '*.o' -o -name '*.rsj' \) -delete
  rm -rf "$dest"
  mv "$dest.tmp" "$dest"
}

mkdir -p "$VENDOR"
if [ ! -d "$VENDOR/internettools" ]; then
  fetch_pinned "$IT_REPO" "$IT_COMMIT" "$VENDOR/internettools"
else
  echo "fetch-vendor: vendor/internettools present"
fi
if [ ! -d "$VENDOR/FLRE" ]; then
  fetch_pinned "$FLRE_REPO" "$FLRE_COMMIT" "$VENDOR/FLRE"
else
  echo "fetch-vendor: vendor/FLRE present"
fi

echo "fetch-vendor: pinned internettools=$IT_COMMIT flre=$FLRE_COMMIT"
