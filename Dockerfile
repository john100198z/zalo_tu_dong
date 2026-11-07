FROM node:24-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY server/package*.json server/
COPY web/package*.json web/
RUN npm --prefix server ci && npm --prefix web ci

COPY server server
COPY web web
RUN npm --prefix web run build && npm --prefix server run build && npm --prefix server prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/package.json server/
COPY --from=build /app/web/dist web/dist
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
