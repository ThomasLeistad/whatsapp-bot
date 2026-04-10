# Dockerfile — WhatsApp Cobranzas Onlysoft
FROM node:18

# ── 1. Solo las libs del sistema que Chrome necesita ──
# Dejamos que Puppeteer descargue su propio Chrome compatible.
# Solo instalamos las librerías compartidas que le faltan al SO.
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
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
    fonts-freefont-ttf \
    fonts-liberation \
    tesseract-ocr \
    tesseract-ocr-spa \
    poppler-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Puppeteer descarga su propio Chrome — ahora sí tiene todas las libs
RUN npm install --omit=dev

COPY . .

RUN mkdir -p comprobantes sessions logs

EXPOSE 3000
CMD ["npm", "start"]
