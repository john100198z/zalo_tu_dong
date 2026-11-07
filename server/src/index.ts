import fs from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { zalo } from "./zalo/service.js";
import { registerAuthRoutes } from "./http/auth.js";
import { registerApiRoutes } from "./http/routes.js";
import { registerWs } from "./http/ws.js";
import { telegram } from "./telegram.js";

const app = Fastify({
  trustProxy: true,
  logger: config.isDev
    ? { level: "info", transport: { target: "pino-pretty", options: { ignore: "pid,hostname,reqId" } } }
    : { level: "warn" },
});

await app.register(cookie, { secret: config.sessionSecret });
await app.register(websocket);

registerAuthRoutes(app);
registerApiRoutes(app);
registerWs(app);

if (fs.existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"),
  );
}

await app.listen({ port: config.port, host: config.host });
console.log(`Web panel: http://localhost:${config.port}`);

void zalo.restore();
telegram.start();

// Lỗi lẻ trong thư viện không được làm sập cả bot.
process.on("unhandledRejection", (err) => console.error("[process] Promise lỗi không được xử lý:", err));
process.on("uncaughtException", (err) => {
  console.error("[process] Lỗi nghiêm trọng, thoát để pm2/Docker khởi động lại:", err);
  process.exit(1);
});

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
