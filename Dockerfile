# Stage 1: Build
FROM node:22-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
RUN node -e 'const fs=require("fs"),f="node_modules/next/dist/compiled/@next/font/dist/google/loader.js";if(fs.existsSync(f))fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(".exec(googleFontFileUrl)[1]",".exec(googleFontFileUrl)?.[1]||\"woff2\""))'

COPY . .
RUN find app components lib -type f -name '*.csv' -delete 2>/dev/null || true
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Production Runner with PM2
FROM node:22-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    npm install -g pm2 && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4500

RUN mkdir -p /app/data /var/www/swapup-downloads /var/www/swapup-web/store /var/www/swapup-web/check

COPY --from=builder /app/package.json /app/package-lock.json /app/next.config.ts ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/deploy ./deploy

RUN chmod +x ./deploy/start.sh

EXPOSE 4500
CMD ["pm2-runtime", "start", "./deploy/start.sh", "--name", "swapup"]
