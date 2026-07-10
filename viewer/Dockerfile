# localcamera-service viewer — Node + ffmpeg + go2rtc + people counter.
# Debian base (glibc) so the native modules (better-sqlite3, onnxruntime-node)
# work on amd64 and arm64 — both ship prebuilt glibc binaries and neither has a
# musl build, so Alpine is not an option. Build context is this viewer/ directory.

# ---- builder: install node deps + fetch the detection models ----
FROM node:20-slim AS build
# NOTE: no default value. `ARG TARGETARCH=amd64` would SHADOW the value buildx
# injects, and every arch would silently get amd64 binaries.
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# onnxruntime-node's postinstall only fetches the optional CUDA (GPU) binaries.
# We run on CPU, and those are bundled in the package, so skip the download.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci --omit=dev
# onnxruntime-node bundles prebuilt binaries for every OS/arch (~230MB).
# Keep only the one this image actually runs on.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) ort=x64 ;; \
      arm64) ort=arm64 ;; \
      *) echo "unsupported TARGETARCH='$TARGETARCH'" >&2; exit 1 ;; \
    esac; \
    bin=node_modules/onnxruntime-node/bin/napi-v6; \
    rm -rf "$bin/darwin" "$bin/win32"; \
    find "$bin/linux" -mindepth 1 -maxdepth 1 ! -name "$ort" -exec rm -rf {} +; \
    test -f "$bin/linux/$ort/onnxruntime_binding.node"
# detection models (coco-ssd ~17MB + yolov10n ~9MB) baked in so it's fully offline
COPY models/fetch-model.sh ./models/fetch-model.sh
RUN sh ./models/fetch-model.sh

# ---- runtime ----
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg tini wget ca-certificates && rm -rf /var/lib/apt/lists/*

# go2rtc turns the camera's RTSP into WebRTC. TARGETARCH is injected by buildx —
# do NOT give it a default, that shadows the injected value and every arch ends
# up with the amd64 binary. Unknown arch fails the build rather than guessing.
ARG GO2RTC_VERSION=v1.9.14
ARG TARGETARCH
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) g2="go2rtc_linux_amd64" ;; \
      arm64) g2="go2rtc_linux_arm64" ;; \
      arm)   g2="go2rtc_linux_arm" ;; \
      *) echo "unsupported TARGETARCH='$TARGETARCH'" >&2; exit 1 ;; \
    esac; \
    wget -O /usr/local/bin/go2rtc \
      "https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/${g2}"; \
    chmod +x /usr/local/bin/go2rtc

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/models ./models
COPY package.json ./
COPY server.js counter.js ./
COPY detectors ./detectors
COPY public ./public
COPY go2rtc/go2rtc.yaml ./go2rtc/go2rtc.yaml
COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# CAMERA_IP is the only one you must set. DB_PATH lives on a volume so the
# people-count history survives redeploys. DETECTOR picks the engine at boot
# (cocossd | yolo); it can also be switched at runtime from the People tab.
ENV CAMERA_IP=192.168.0.143 \
    PORT=8080 \
    GO2RTC_PORT=1984 \
    DB_PATH=/data/occupancy.db \
    DETECTOR=cocossd
VOLUME /data

# 8080 viewer | 1984 go2rtc API+WS | 8555 WebRTC media (tcp+udp)
EXPOSE 8080 1984 8555 8555/udp

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/api/info" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
