# 1. Usamos una imagen base de Node.js estable
FROM node:18-slim

# 2. Instalamos las dependencias necesarias para que Puppeteer (Chrome) corra en Linux
# Esto es fundamental para que whatsapp-web.js no tire error en el servidor [cite: 52]
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    libxss1 \
    libglu1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 3. Seteamos la variable de entorno para que la librería encuentre el ejecutable de Chromium
ENV CHROME_PATH=/usr/bin/chromium

# 4. Creamos el directorio de la app
WORKDIR /app

# 5. Copiamos los archivos de dependencias e instalamos
COPY package*.json ./
RUN npm install

# 6. Copiamos el resto del código del bot
COPY . .

# 7. Creamos la carpeta para guardar los comprobantes [cite: 10, 49]
RUN mkdir -p comprobantes

# 8. Comando para iniciar el bot
CMD ["npm", "start"]