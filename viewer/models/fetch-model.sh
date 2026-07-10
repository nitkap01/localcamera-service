#!/bin/sh
# Download the person-detection models for offline use. Files land next to this
# script and are loaded from disk at runtime — nothing is fetched from the
# internet once this has run.
#
#   coco-ssd/  ssdlite_mobilenet_v2, TensorFlow.js  (~17MB)
#   yolo/      yolov10n.onnx, onnxruntime           (~9MB, AGPL-3.0)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
SSD="https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2"
YOLO="https://huggingface.co/onnx-community/yolov10n/resolve/main/onnx/model.onnx"

mkdir -p "$DIR/coco-ssd" "$DIR/yolo"

echo "fetching coco-ssd -> $DIR/coco-ssd"
wget -qO "$DIR/coco-ssd/model.json" "$SSD/model.json"
for i in 1 2 3 4 5; do
  wget -qO "$DIR/coco-ssd/group1-shard${i}of5" "$SSD/group1-shard${i}of5"
done

echo "fetching yolov10n -> $DIR/yolo"
wget -qO "$DIR/yolo/yolov10n.onnx" "$YOLO"

echo "done (coco-ssd: $(ls "$DIR/coco-ssd" | wc -l | tr -d ' ') files, yolo: yolov10n.onnx)"
