# localcamera-service viewer — Node + ffmpeg + go2rtc (WebRTC) in one image.
# Build context is this viewer/ directory.
FROM node:20-alpine

# ffmpeg drives MJPEG / snapshot / record. tini reaps child processes.
# busybox wget (already in the base) fetches the go2rtc binary below.
RUN apk add --no-cache ffmpeg tini

# go2rtc turns the camera's RTSP into WebRTC. Pull the matching static build.
# TARGETARCH is provided automatically by "docker buildx" (amd64 / arm64 / arm).
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

# Install only production deps (express) against the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code + the go2rtc config (reads ${CAMERA_IP} from the environment).
COPY server.js ./
COPY public ./public
COPY go2rtc/go2rtc.yaml ./go2rtc/go2rtc.yaml
COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Defaults — override CAMERA_IP at run time (the only one you must set).
ENV CAMERA_IP=192.168.0.143 \
    PORT=8080 \
    GO2RTC_PORT=1984

# 8080 viewer | 1984 go2rtc API+WS (WebRTC signaling) | 8555 WebRTC media (tcp+udp)
EXPOSE 8080 1984 8555 8555/udp

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/api/info" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
