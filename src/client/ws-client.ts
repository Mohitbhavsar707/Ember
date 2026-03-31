// src/client/ws-client.ts
//
// A typed WebSocket client for the Phoenix LOB server.
// Works in both browser (native WebSocket) and Node.js (ws package).
// Consumers get a clean async API with auto-reconnect and typed events.
//
// Usage (browser or Node):
//
//   import { PhoenixClient } from './ws-client.js'
//
//   const client = new PhoenixClient('ws://localhost:3000')
//   await client.connect()
//
//   client.on('snapshot', (snap) => console.log(snap.midPrice))
//   client.on('fill',     (fill) => console.log(fill))
//
//   const result = await client.placeLimitOrder('buy', 142.50, 1.0)
//   const cancel = await client.cancelOrder(result.order.id)

import EventEmitter from "events";
import { BookSnapshot, Fill, PlaceOrderResult, CancelOrderResult, Side } from "../engine/types.js";

// The server sends these message shapes
type ServerMessage =
  | { type: "snapshot" } & BookSnapshot & { fills: Fill[] }
  | { type: "fill"; fill: Fill }
  | { type: "ack"; result: PlaceOrderResult | CancelOrderResult }
  | { type: "error"; message: string };

// Pending request: we correlate acks via a simple FIFO queue per message type
// (the server processes messages in order per connection)
interface PendingRequest {
  resolve: (value: PlaceOrderResult | CancelOrderResult) => void;
  reject:  (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface PhoenixClientOptions {
  reconnectDelayMs?: number;
  requestTimeoutMs?: number;
  /** Supply the WebSocket constructor to use (defaults to globalThis.WebSocket, or 'ws' package in Node) */
  WebSocketImpl?: typeof WebSocket;
}

export class PhoenixClient extends EventEmitter {
  private readonly url: string;
  private readonly opts: Required<PhoenixClientOptions>;
  private ws: WebSocket | null = null;
  private pendingRequests: PendingRequest[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;

  constructor(url: string, opts: PhoenixClientOptions = {}) {
    super();
    this.url = url;
    this.opts = {
      reconnectDelayMs: opts.reconnectDelayMs ?? 2000,
      requestTimeoutMs: opts.requestTimeoutMs ?? 5000,
      WebSocketImpl: opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const WS = this.opts.WebSocketImpl;
      this.ws = new WS(this.url) as unknown as WebSocket;

      this.ws.onopen = () => {
        this._connected = true;
        this.emit("connected");
        this.ws!.send(JSON.stringify({ type: "subscribe" }));
        resolve();
      };

      this.ws.onerror = (err) => {
        if (!this._connected) reject(err);
        this.emit("error", err);
      };

      this.ws.onclose = () => {
        this._connected = false;
        this.emit("disconnected");
        this._scheduleReconnect();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this._handleMessage(event.data as string);
      };
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Place a limit order. Returns the full PlaceOrderResult including fills.
   */
  async placeLimitOrder(
    side: Side,
    price: number,
    size: number,
    clientOrderId?: string
  ): Promise<PlaceOrderResult> {
    return this._sendRequest({ type: "limit", side, price, size, clientOrderId }) as Promise<PlaceOrderResult>;
  }

  /**
   * Place a market order.
   */
  async placeMarketOrder(
    side: Side,
    size: number,
    clientOrderId?: string
  ): Promise<PlaceOrderResult> {
    return this._sendRequest({ type: "market", side, size, clientOrderId }) as Promise<PlaceOrderResult>;
  }

  /**
   * Cancel a resting order by ID.
   */
  async cancelOrder(orderId: number): Promise<CancelOrderResult> {
    return this._sendRequest({ type: "cancel", orderId }) as Promise<CancelOrderResult>;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _send(payload: object): void {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      throw new Error("not connected");
    }
    this.ws.send(JSON.stringify(payload));
  }

  private _sendRequest(payload: object): Promise<PlaceOrderResult | CancelOrderResult> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.pendingRequests.indexOf(pending);
        if (idx !== -1) this.pendingRequests.splice(idx, 1);
        reject(new Error(`request timed out after ${this.opts.requestTimeoutMs}ms`));
      }, this.opts.requestTimeoutMs);

      const pending: PendingRequest = { resolve, reject, timeoutId };
      this.pendingRequests.push(pending);

      try {
        this._send(payload);
      } catch (err) {
        this.pendingRequests.pop();
        clearTimeout(timeoutId);
        reject(err);
      }
    });
  }

  private _handleMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      this.emit("error", new Error(`unparseable message: ${raw}`));
      return;
    }

    if (msg.type === "snapshot") {
      this.emit("snapshot", msg);
    } else if (msg.type === "fill") {
      this.emit("fill", msg.fill);
    } else if (msg.type === "ack") {
      const pending = this.pendingRequests.shift();
      if (pending) {
        clearTimeout(pending.timeoutId);
        pending.resolve(msg.result);
      }
    } else if (msg.type === "error") {
      const pending = this.pendingRequests.shift();
      if (pending) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(msg.message));
      } else {
        this.emit("error", new Error(msg.message));
      }
    }
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        // onclose will schedule another reconnect
      }
    }, this.opts.reconnectDelayMs);
  }
}
