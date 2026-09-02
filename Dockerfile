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

# Pre-download the chroma_default ONNX embedding model so the first
# ingestion doesn't have to fetch ~80 MB at runtime (which times out
# under slow networks — see onnx_mini_lm_l6_v2.py _download).
# The model is ~80 MB tar.gz from S3; we use wget with resume/retry
# because httpx's 5s read timeout is too short for slow links.
RUN mkdir -p /root/.cache/chroma/onnx_models/all-MiniLM-L6-v2 && \
    wget --tries=5 --timeout=60 --continue -O /root/.cache/chroma/onnx_models/all-MiniLM-L6-v2/onnx.tar.gz \
        https://chroma-onnx-models.s3.amazonaws.com/all-MiniLM-L6-v2/onnx.tar.gz && \
    tar -xzf /root/.cache/chroma/onnx_models/all-MiniLM-L6-v2/onnx.tar.gz -C /root/.cache/chroma/onnx_models/all-MiniLM-L6-v2 && \
    ls -lh /root/.cache/chroma/onnx_models/all-MiniLM-L6-v2/onnx/ && \
    python -c "from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2; ef = ONNXMiniLM_L6_V2(); print('ONNX warm-up ok:', ef(['hello world', 'bookify test'])[0][:3])" || \
    (echo "WARN: ONNX warm-up failed — model will be fetched at runtime" && true)

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
