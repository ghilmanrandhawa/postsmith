FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:widget
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/postsmith.db
VOLUME /data
EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
