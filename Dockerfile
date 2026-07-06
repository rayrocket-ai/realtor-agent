FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
# Chromium + system deps for the REALM/BrokerBay booking browser
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
# tsx + src are kept for the one-time `npm run auth:google` / `npm run book` CLIs
COPY src ./src
COPY tsconfig.json ./
RUN npm install --no-save tsx typescript >/dev/null 2>&1 || true
EXPOSE 3000
CMD ["node", "dist/index.js"]
