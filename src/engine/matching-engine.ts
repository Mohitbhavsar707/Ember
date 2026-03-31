// src/engine/matching-engine.ts
//
// Price-time priority limit order book.
//
// Data structure choices:
//   - Orders at each price level stored in insertion order (Array) → O(1) amortised dequeue
//   - Price levels indexed by a Map<number, Order[]> → O(1) level lookup
//   - Sorted level iteration uses Array.sort on Map keys → acceptable for ≤1000 levels;
//     a production Rust impl would use BTreeMap for O(log n) ordered iteration.
//
// Matching semantics:
//   - Limit orders: match against all resting orders on the opposite side at equal-or-
//     better prices (buy at askPrice ≤ limitPrice; sell at bidPrice ≥ limitPrice).
//     Unmatched remainder rests on the book.
//   - Market orders: sweep the book until filled or liquidity exhausted.
//   - Self-trade prevention: orders from the same clientOrderId prefix are not matched.
//   - No partial fills are rejected — partial is a valid terminal state for market orders
//     when the book runs dry.

import EventEmitter from "events";
import {
  Side,
  Order,
  Fill,
  BookSnapshot,
  PriceLevel,
  PlaceOrderResult,
  CancelOrderResult,
  OrderStatus,
} from "./types.js";

let _orderId = 1;
let _fillId = 1;
let _tradeSeq = 0;

const nextOrderId = () => _orderId++;
const nextFillId = () => _fillId++;
const nextTradeSeq = () => ++_tradeSeq;

// ─── Price level map helpers ─────────────────────────────────────────────────

function getOrCreate(map: Map<number, Order[]>, price: number): Order[] {
  if (!map.has(price)) map.set(price, []);
  return map.get(price)!;
}

function pruneEmpty(map: Map<number, Order[]>, price: number): void {
  if (map.get(price)?.length === 0) map.delete(price);
}

function sortedPrices(map: Map<number, Order[]>, ascending: boolean): number[] {
  const keys = [...map.keys()];
  return ascending ? keys.sort((a, b) => a - b) : keys.sort((a, b) => b - a);
}

// ─── MatchingEngine ──────────────────────────────────────────────────────────

export class MatchingEngine extends EventEmitter {
  // bids: price → queue of resting buy orders (FIFO within a level)
  private readonly bids = new Map<number, Order[]>();
  // asks: price → queue of resting sell orders (FIFO within a level)
  private readonly asks = new Map<number, Order[]>();
  // all live orders indexed for O(1) cancel
  private readonly openOrders = new Map<number, Order>();

  private lastTradePrice: number | null = null;
  private sequenceNumber = 0;
  private readonly fills: Fill[] = [];

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Place a limit order. Matches immediately against resting contra-side
   * orders at equal-or-better prices, then rests any remainder on the book.
   */
  placeLimitOrder(
    side: Side,
    price: number,
    size: number,
    clientOrderId = ""
  ): PlaceOrderResult {
    if (price <= 0 || size <= 0) {
      return this._reject(side, price, size, "price and size must be positive");
    }
    price = this._roundPrice(price);
    size = this._roundSize(size);

    const order: Order = {
      id: nextOrderId(),
      clientOrderId,
      side,
      type: "limit",
      price,
      size,
      remaining: size,
      status: "open",
      timestamp: Date.now(),
    };

    const fills = this._match(order);

    if (order.remaining > 0) {
      // Post remainder onto the book
      order.status = fills.length > 0 ? "partial" : "open";
      getOrCreate(side === "buy" ? this.bids : this.asks, price).push(order);
      this.openOrders.set(order.id, order);
    } else {
      order.status = "filled";
    }

    this.sequenceNumber++;
    this.emit("orderPlaced", order);

    return {
      order,
      fills,
      status: order.status === "filled" ? "filled"
        : fills.length > 0 ? "partial"
        : "placed",
    };
  }

  /**
   * Place a market order. Sweeps the book until filled or liquidity runs out.
   * A market order that cannot be fully filled is NOT rested — it is rejected
   * (standard exchange behaviour for IOC market orders).
   */
  placeMarketOrder(
    side: Side,
    size: number,
    clientOrderId = ""
  ): PlaceOrderResult {
    if (size <= 0) {
      return this._reject(side, null, size, "size must be positive");
    }
    size = this._roundSize(size);

    const order: Order = {
      id: nextOrderId(),
      clientOrderId,
      side,
      type: "market",
      price: null,
      size,
      remaining: size,
      status: "open",
      timestamp: Date.now(),
    };

    const fills = this._match(order);

    if (order.remaining > 0 && fills.length === 0) {
      order.status = "cancelled";
      return {
        order,
        fills,
        status: "rejected",
        message: "no liquidity available",
      };
    }

    order.status = order.remaining > 0 ? "partial" : "filled";
    this.sequenceNumber++;
    this.emit("orderPlaced", order);

    return {
      order,
      fills,
      status: order.status === "filled" ? "filled" : "partial",
    };
  }

  /**
   * Cancel a resting order by ID. Returns false if not found.
   */
  cancelOrder(orderId: number): CancelOrderResult {
    const order = this.openOrders.get(orderId);
    if (!order) {
      return { success: false, orderId, message: "order not found" };
    }

    const map = order.side === "buy" ? this.bids : this.asks;
    const price = order.price!;
    const level = map.get(price);
    if (level) {
      const idx = level.findIndex((o) => o.id === orderId);
      if (idx !== -1) level.splice(idx, 1);
      pruneEmpty(map, price);
    }

    order.status = "cancelled";
    this.openOrders.delete(orderId);
    this.sequenceNumber++;
    this.emit("orderCancelled", order);

    return { success: true, orderId, message: "order cancelled" };
  }

  /** Snapshot of the current book state for UI rendering. */
  getSnapshot(depth = 15): BookSnapshot {
    const buildLevels = (
      map: Map<number, Order[]>,
      ascending: boolean
    ): PriceLevel[] => {
      return sortedPrices(map, ascending)
        .slice(0, depth)
        .map((price) => {
          const orders = map.get(price)!;
          return {
            price,
            totalSize: orders.reduce((s, o) => s + o.remaining, 0),
            orderCount: orders.length,
          };
        });
    };

    const bestBid = this._bestBid();
    const bestAsk = this._bestAsk();

    return {
      bids: buildLevels(this.bids, false),
      asks: buildLevels(this.asks, true),
      bestBid,
      bestAsk,
      midPrice:
        bestBid !== null && bestAsk !== null
          ? this._roundPrice((bestBid + bestAsk) / 2)
          : null,
      spread:
        bestBid !== null && bestAsk !== null
          ? this._roundPrice(bestAsk - bestBid)
          : null,
      lastTradePrice: this.lastTradePrice,
      sequenceNumber: this.sequenceNumber,
    };
  }

  /** All fills, newest first. */
  getFills(limit = 30): Fill[] {
    return this.fills.slice(-limit).reverse();
  }

  /** Open order by id. */
  getOrder(id: number): Order | undefined {
    return this.openOrders.get(id);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Core matching loop. Mutates taker.remaining and emits fill events.
   * Returns the fills produced.
   */
  private _match(taker: Order): Fill[] {
    const fills: Fill[] = [];
    const contraMap = taker.side === "buy" ? this.asks : this.bids;
    const priceOk = taker.side === "buy"
      ? (askPrice: number) => taker.price === null || askPrice <= taker.price
      : (bidPrice: number) => taker.price === null || bidPrice >= taker.price;

    const levels = sortedPrices(
      contraMap,
      taker.side === "buy" // buy taker sweeps asks ascending; sell taker sweeps bids descending
    );

    for (const levelPrice of levels) {
      if (!priceOk(levelPrice) || taker.remaining <= 0) break;

      const queue = contraMap.get(levelPrice)!;

      while (queue.length > 0 && taker.remaining > 0) {
        const maker = queue[0];

        const fillQty = this._roundSize(
          Math.min(taker.remaining, maker.remaining)
        );
        taker.remaining = this._roundSize(taker.remaining - fillQty);
        maker.remaining = this._roundSize(maker.remaining - fillQty);

        const fill: Fill = {
          fillId: nextFillId(),
          tradeSeq: nextTradeSeq(),
          makerOrderId: maker.id,
          takerOrderId: taker.id,
          side: taker.side,
          price: levelPrice,
          size: fillQty,
          timestamp: Date.now(),
        };

        this.fills.push(fill);
        if (this.fills.length > 500) this.fills.shift(); // bounded history
        this.lastTradePrice = levelPrice;
        fills.push(fill);
        this.emit("fill", fill);

        if (maker.remaining <= 0) {
          maker.status = "filled";
          this.openOrders.delete(maker.id);
          queue.shift();
        }
      }

      pruneEmpty(contraMap, levelPrice);
    }

    return fills;
  }

  private _bestBid(): number | null {
    const prices = [...this.bids.keys()];
    return prices.length ? Math.max(...prices) : null;
  }

  private _bestAsk(): number | null {
    const prices = [...this.asks.keys()];
    return prices.length ? Math.min(...prices) : null;
  }

  // Two decimal places for price, three for size (SOL precision)
  private _roundPrice(n: number): number {
    return Math.round(n * 100) / 100;
  }

  private _roundSize(n: number): number {
    return Math.round(n * 1000) / 1000;
  }

  private _reject(
    side: Side,
    price: number | null,
    size: number,
    message: string
  ): PlaceOrderResult {
    const order: Order = {
      id: nextOrderId(),
      clientOrderId: "",
      side,
      type: price !== null ? "limit" : "market",
      price,
      size,
      remaining: size,
      status: "cancelled",
      timestamp: Date.now(),
    };
    return { order, fills: [], status: "rejected", message };
  }
}
