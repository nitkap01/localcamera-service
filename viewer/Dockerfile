# localcamera-service viewer — Node + ffmpeg + go2rtc + people counter.
# Debian base (glibc) so the native module (better-sqlite3) installs cleanly on
# amd64 and arm64; person detection uses TensorFlow.js on the WASM backend (no
# native TF), so it runs anywhere. Build context is this viewer/ directory.

# ---- builder: install node deps + fetch the detection model ----
FROM node:20-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# coco-ssd model (~17MB) baked in so detection is fully offline at runtime
COPY models/fetch-model.sh ./models/fetch-model.sh
RUN sh ./models/fetch-model.sh

# ---- runtime ----
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg tini wget ca-certificates && rm -rf /var/lib/apt/lists/*

# go2rtc turns the camera's RTSP into WebRTC. TARGETARCH is set by docker buildx.
ARG GO2RTC_VERSION=v1.9.14
ARG TARGETARCH=amd64
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) g2="go2rtc_linux_amd64" ;; \
      arm64) g2="go2rtc_linux_arm64" ;; \
      arm)   g2="go2rtc_linux_arm" ;; \
      *)     g2="go2rtc_linux_amd64" ;; \
    esac; \
    wget -O /usr/local/bin/go2rtc \
      "https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/${g2}"; \
    chmod +x /usr/local/bin/go2rtc

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/models ./models
COPY package.json ./
COPY server.js counter.js ./
COPY public ./public
COPY go2rtc/go2rtc.yaml ./go2rtc/go2rtc.yaml
COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# CAMERA_IP is the only one you must set. DB_PATH lives on a volume so the
# people-count history survives redeploys.
ENV CAMERA_IP=192.168.0.143 \
    PORT=8080 \
    GO2RTC_PORT=1984 \
    DB_PATH=/data/occupancy.db
VOLUME /data

# 8080 viewer | 1984 go2rtc API+WS | 8555 WebRTC media (tcp+udp)
EXPOSE 8080 1984 8555 8555/udp

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/api/info" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
