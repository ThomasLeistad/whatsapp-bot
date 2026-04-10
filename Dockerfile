# Dockerfile — WhatsApp Cobranzas Onlysoft
FROM node:18-slim

# ── Dependencias del sistema ──
# chromium    → para whatsapp-web.js (Puppeteer)
# tesseract-ocr + tesseract-ocr-spa → OCR en español
# poppler-utils → pdftoppm para convertir PDF a imagen antes del OCR
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    fonts-liberation \
    libxss1 \
    libglu1-mesa \
    tesseract-ocr \
    tesseract-ocr-spa \
    poppler-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ── Variables de entorno para Chromium/Puppeteer ──
ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# ── Directorio de trabajo ──
WORKDIR /app

# ── Instalar dependencias Node ──
COPY package*.json ./
RUN npm install --omit=dev

# ── Copiar código fuente ──
COPY . .

# ── Crear directorios necesarios ──
RUN mkdir -p comprobantes sessions logs

# ── Puerto expuesto ──
EXPOSE 3000

# ── Comando de inicio ──
CMD ["npm", "start"]
