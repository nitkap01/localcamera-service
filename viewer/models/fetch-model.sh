#!/bin/sh
# Download the coco-ssd person/object model (ssdlite_mobilenet_v2) for offline
# detection. Files land in models/coco-ssd/ and are loaded locally at runtime —
# nothing is fetched from the internet once this has run.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)/coco-ssd"
BASE="https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2"
mkdir -p "$DIR"
echo "fetching coco-ssd model -> $DIR"
wget -qO "$DIR/model.json" "$BASE/model.json"
for i in 1 2 3 4 5; do
  wget -qO "$DIR/group1-shard${i}of5" "$BASE/group1-shard${i}of5"
done
echo "done ($(ls "$DIR" | wc -l | tr -d ' ') files)"
