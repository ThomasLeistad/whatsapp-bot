# Dockerfile — WhatsApp Cobranzas Onlysoft
FROM node:18

# ── 1. Google Chrome estable (funciona en Ubuntu Noble dentro de Docker) ──
# chromium-browser en Ubuntu 24+ es un snap → no funciona en Docker.
# Usamos el Chrome oficial de Google directamente.
RUN apt-get update && apt-get install -y wget gnupg ca-certificates \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
       http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y \
       google-chrome-stable \
       fonts-freefont-ttf \
       fonts-liberation \
       tesseract-ocr \
       tesseract-ocr-spa \
       poppler-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Variables de Puppeteer ANTES del npm install ──
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV CHROME_PATH=/usr/bin/google-chrome-stable

# ── 3. Directorio de trabajo ──
WORKDIR /app

# ── 4. .npmrc y dependencias ──
COPY .npmrc ./
COPY package*.json ./
RUN npm install --omit=dev \
    && rm -rf /root/.cache/puppeteer

# ── 5. Código fuente ──
COPY . .

RUN mkdir -p comprobantes sessions logs

EXPOSE 3000
CMD ["npm", "start"]
