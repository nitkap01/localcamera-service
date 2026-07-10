#!/bin/sh
# Download the person-detection models for offline use. Files land next to this
# script and are loaded from disk at runtime — nothing is fetched from the
# internet once this has run.
#
# Server-side (people counter):
#   coco-ssd/  ssdlite_mobilenet_v2, TensorFlow.js  (~17MB)
#   yolo/      yolov10n.onnx, onnxruntime           (~9MB, AGPL-3.0)
# Browser-side (live overlay: boxes, hand gestures, face expressions):
#   mediapipe/ efficientdet_lite0 + gesture_recognizer + face_landmarker (~18MB)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
SSD="https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2"
YOLO="https://huggingface.co/onnx-community/yolov10n/resolve/main/onnx/model.onnx"
MP="https://storage.googleapis.com/mediapipe-models"

mkdir -p "$DIR/coco-ssd" "$DIR/yolo" "$DIR/mediapipe"

echo "fetching coco-ssd -> $DIR/coco-ssd"
wget -qO "$DIR/coco-ssd/model.json" "$SSD/model.json"
for i in 1 2 3 4 5; do
  wget -qO "$DIR/coco-ssd/group1-shard${i}of5" "$SSD/group1-shard${i}of5"
done

echo "fetching yolov10n -> $DIR/yolo"
wget -qO "$DIR/yolo/yolov10n.onnx" "$YOLO"

echo "fetching mediapipe overlay models -> $DIR/mediapipe"
wget -qO "$DIR/mediapipe/efficientdet_lite0.tflite" "$MP/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite"
wget -qO "$DIR/mediapipe/gesture_recognizer.task"   "$MP/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
wget -qO "$DIR/mediapipe/face_landmarker.task"      "$MP/face_landmarker/face_landmarker/float16/1/face_landmarker.task"

echo "done (coco-ssd: $(ls "$DIR/coco-ssd" | wc -l | tr -d ' ') files, yolo: yolov10n.onnx, mediapipe: $(ls "$DIR/mediapipe" | wc -l | tr -d ' ') files)"
