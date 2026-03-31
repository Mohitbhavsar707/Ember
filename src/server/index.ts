// src/server/index.ts
//
// Express HTTP server + WebSocket server.
//
// REST endpoints (useful for testing with curl):
//   POST /orders/limit    { side, price, size, clientOrderId? }
//   POST /orders/market   { side, size, clientOrderId? }
//   DELETE /orders/:id
//   GET  /book            → snapshot
//   GET  /fills           → recent fills
//
// WebSocket protocol:
//   Client → Server (JSON):
//     { type: "limit",  side, price, size, clientOrderId? }
//     { type: "market", side, size, clientOrderId? }
//     { type: "cancel", orderId }
//     { type: "subscribe" }  ← start receiving broadcasts
//
//   Server → Client (JSON):
//     { type: "snapshot", ...BookSnapshot, fills: Fill[] }      // on subscribe + after each order
//     { type: "fill",    fill: Fill }                           // broadcast to all on trade
//     { type: "ack",     result: PlaceOrderResult | CancelOrderResult }
//     { type: "error",   message: string }

import express, { Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { MatchingEngine } from "../engine/matching-engine.js";
import { MarketMaker } from "../engine/market-maker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// ─── Engine setup ─────────────────────────────────────────────────────────────

const engine = new MatchingEngine();
const mm = new MarketMaker(engine);
mm.seed();
mm.start();

// ─── Express ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../../public")));

app.post("/orders/limit", (req: Request, res: Response) => {
  const { side, price, size, clientOrderId } = req.body;
  if (!side || !price || !size) {
    res.status(400).json({ error: "side, price, size required" });
    return;
  }
  const result = engine.placeLimitOrder(side, +price, +size, clientOrderId);
  broadcastSnapshot();
  res.json(result);
});

app.post("/orders/market", (req: Request, res: Response) => {
  const { side, size, clientOrderId } = req.body;
  if (!side || !size) {
    res.status(400).json({ error: "side, size required" });
    return;
  }
  const result = engine.placeMarketOrder(side, +size, clientOrderId);
  broadcastSnapshot();
  res.json(result);
});

app.delete("/orders/:id", (req: Request, res: Response) => {
  const result = engine.cancelOrder(parseInt(req.params.id));
  broadcastSnapshot();
  res.json(result);
});

app.get("/book", (_req: Request, res: Response) => {
  res.json(engine.getSnapshot());
});

app.get("/fills", (_req: Request, res: Response) => {
  res.json(engine.getFills());
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const subscribers = new Set<WebSocket>();

function broadcastSnapshot(): void {
  if (subscribers.size === 0) return;
  const payload = JSON.stringify({
    type: "snapshot",
    ...engine.getSnapshot(),
    fills: engine.getFills(20),
  });
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// Broadcast fills to all subscribers in real time
engine.on("fill", (fill) => {
  const payload = JSON.stringify({ type: "fill", fill });
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
  // also push a snapshot so the book updates
  broadcastSnapshot();
});

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
      return;
    }

    try {
      switch (msg.type) {
        case "subscribe": {
          subscribers.add(ws);
          ws.send(
            JSON.stringify({
              type: "snapshot",
              ...engine.getSnapshot(),
              fills: engine.getFills(20),
            })
          );
          break;
        }

        case "limit": {
          const { side, price, size, clientOrderId } = msg as {
            side: string; price: number; size: number; clientOrderId?: string
          };
          const result = engine.placeLimitOrder(
            side as "buy" | "sell",
            +price,
            +size,
            clientOrderId
          );
          ws.send(JSON.stringify({ type: "ack", result }));
          broadcastSnapshot();
          break;
        }

        case "market": {
          const { side, size, clientOrderId } = msg as {
            side: string; size: number; clientOrderId?: string
          };
          const result = engine.placeMarketOrder(
            side as "buy" | "sell",
            +size,
            clientOrderId
          );
          ws.send(JSON.stringify({ type: "ack", result }));
          broadcastSnapshot();
          break;
        }

        case "cancel": {
          const { orderId } = msg as { orderId: number };
          const result = engine.cancelOrder(+orderId);
          ws.send(JSON.stringify({ type: "ack", result }));
          broadcastSnapshot();
          break;
        }

        default:
          ws.send(JSON.stringify({ type: "error", message: `unknown type: ${msg.type}` }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: String(err) }));
    }
  });

  ws.on("close", () => subscribers.delete(ws));
});

server.listen(PORT, () => {
  console.log(`\n🔥 Phoenix LOB running at http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   REST book: GET http://localhost:${PORT}/book\n`);
});

export { engine, server };
