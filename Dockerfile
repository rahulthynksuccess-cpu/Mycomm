# Use full Debian (not slim) — has more system libs pre-installed
FROM node:20-bookworm

# Install Chromium + ALL its shared library dependencies
# This is the complete list required for Chromium on Debian Bookworm
RUN apt-get update && apt-get install -y \
  chromium \
  chromium-sandbox \
  ca-certificates \
  fonts-liberation \
  fonts-noto-color-emoji \
  libglib2.0-0 \
  libglib2.0-dev \
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libdbus-1-3 \
  libxcb1 \
  libxkbcommon0 \
  libx11-6 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libpango-1.0-0 \
  libcairo2 \
  libasound2 \
  libexpat1 \
  libfontconfig1 \
  libfreetype6 \
  libpangocairo-1.0-0 \
  libxss1 \
  libxtst6 \
  libxi6 \
  libxcursor1 \
  libxrender1 \
  libx11-xcb1 \
  xdg-utils \
  wget \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Verify chromium is found and works
RUN which chromium && chromium --version

# Tell puppeteer to use the system Chromium (never download its own)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# Also set for puppeteer-core compatibility
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

# Install backend deps first (better layer caching)
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

# Create sessions directory
RUN mkdir -p /app/backend/sessions

EXPOSE 8080
CMD ["node", "backend/server.js"]
