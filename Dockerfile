# Dockerfile — WhatsApp Cobranzas Onlysoft
FROM node:18-slim

# ── 1. Libs del sistema para Chromium ──
RUN apt-get update && apt-get install -y \
    chromium-browser \
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

WORKDIR /app

# ── 2. .npmrc y package.json van PRIMERO ──
# El .npmrc le dice al postinstall de Puppeteer que no descargue Chrome.
# Tiene que estar en el directorio ANTES de que corra npm install.
COPY .npmrc ./
COPY package*.json ./

# ── 3. Variables de entorno también antes de npm install ──
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV CHROME_PATH=/usr/bin/chromium-browser

# ── 4. npm install + limpiar la caché de Puppeteer por las dudas ──
RUN npm install --omit=dev \
    && rm -rf /root/.cache/puppeteer

# ── 5. Copiar el resto del código ──
COPY . .

RUN mkdir -p comprobantes sessions logs

EXPOSE 3000
CMD ["npm", "start"]
