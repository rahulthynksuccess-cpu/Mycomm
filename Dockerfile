# Baileys uses pure WebSocket — no Chromium needed, much lighter image
FROM node:20-bookworm-slim

# Only need ca-certificates and fonts for QR generation
RUN apt-get update && apt-get install -y \
  ca-certificates \
  git \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend deps
COPY backend/package*.json ./backend/
RUN cd backend && npm install

# Install frontend deps
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install

# Build frontend
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# Copy backend source
COPY backend/ ./backend/

# Sessions directory — persistence handled by Railway Volume in railway.toml
RUN mkdir -p /app/backend/sessions

EXPOSE 8080
CMD ["node", "backend/server.js"]
