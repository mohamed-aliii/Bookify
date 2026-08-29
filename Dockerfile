# syntax=docker/dockerfile:1.6

# ─────────────────────────────────────────────────────────────────
# Stage 1 — frontend (Vite static build)
# ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /build

# Install deps first (better layer cache)
COPY frontend/package*.json ./
RUN npm ci || npm install

# Copy the rest of the frontend and build
COPY frontend/ ./
RUN npm run build

# ─────────────────────────────────────────────────────────────────
# Stage 2 — runtime (Python + nginx + built frontend)
# ─────────────────────────────────────────────────────────────────
FROM python:3.11-slim

# System deps: nginx + wget (health check in entrypoint) + tini (signal handling)
# Note: nginx is installed via apt; python:3.11-slim is Debian-based (bookworm).
RUN apt-get update && apt-get install -y --no-install-recommends \
        nginx \
        wget \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default /etc/nginx/conf.d/default.conf \
    && mkdir -p /var/log/nginx /var/cache/nginx /usr/share/nginx/html

WORKDIR /app
ENV PYTHONPATH=/app/backend
ENV PYTHONUNBUFFERED=1

# Python deps — install first for layer cache.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r backend/requirements.txt

# Backend source
COPY backend/ ./backend/

# Keep a pristine default config in the image so the entrypoint can copy it
# when the user hasn't mounted their own config.toml. Data paths in the
# shipped config are relative (data/…) and resolve to /app/data in-container,
# which is exactly where the named volume is mounted.
COPY config.toml ./config.toml.example
COPY config.toml ./config.toml

# Env template for reference
COPY .env.example ./.env.example

# Frontend static build
COPY --from=frontend-builder /build/dist /usr/share/nginx/html

# Nginx + entrypoint
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Data volume — SQLite db, Chroma vectors, and uploaded PDFs
VOLUME ["/app/data"]

EXPOSE 80

# tini handles PID 1 signal forwarding cleanly for the nginx + uvicorn children
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
