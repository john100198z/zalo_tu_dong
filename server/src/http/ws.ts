import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { bus } from "../events.js";
import { zalo } from "../zalo/service.js";
import { isAuthed } from "./auth.js";

const clients = new Set<WebSocket>();

function broadcast(type: string, data: unknown) {
  const msg = JSON.stringify({ type, data });
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

bus.on("status", (s) => broadcast("status", s));
bus.on("log", (l) => broadcast("log", l));
bus.on("log_update", (l) => broadcast("log_update", l));

export function registerWs(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (socket, req) => {
    if (!isAuthed(req)) {
      socket.close(4401, "unauthorized");
      return;
    }
    clients.add(socket);
    socket.send(JSON.stringify({ type: "status", data: zalo.getStatus() }));
    socket.on("close", () => clients.delete(socket));
  });
}
