FROM node:20-slim

# ffmpeg + шрифты (обычный + цветные эмодзи) + fontconfig, всё одним слоем
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
    fontconfig \
    && fc-cache -f -v \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
