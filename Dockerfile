# Dockerfile — WhatsApp Cobranzas Onlysoft
FROM node:18-slim

# ── 1. Dependencias del sistema ──
# Lista completa de libs que Chrome necesita en Debian slim
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    fonts-liberation \
    libglib2.0-0 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libxss1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxext6 \
    libxrender1 \
    libnss3 \
    libnspr4 \
    tesseract-ocr \
    tesseract-ocr-spa \
    poppler-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Variables de Puppeteer ANTES del npm install ──
# CRÍTICO: si no están antes del npm install, Puppeteer descarga
# su propio Chrome (~400MB) que no tiene las libs del sistema.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_PATH=/usr/bin/chromium

# ── 3. Directorio de trabajo ──
WORKDIR /app

# ── 4. Instalar dependencias Node ──
COPY package*.json ./
RUN npm install --omit=dev

# ── 5. Copiar código fuente ──
COPY . .

# ── 6. Directorios necesarios ──
RUN mkdir -p comprobantes sessions logs

EXPOSE 3000
CMD ["npm", "start"]
