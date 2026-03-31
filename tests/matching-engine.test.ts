// tests/matching-engine.test.ts
//
// Tests cover:
//   - Basic limit/market order placement
//   - Full and partial fills
//   - Price-time priority (FIFO within a level)
//   - Market order with insufficient liquidity
//   - Cancel order
//   - Book snapshot correctness
//   - Edge cases: zero size, zero price, crossed book prevention

import { describe, it, expect, beforeEach } from "vitest";
import { MatchingEngine } from "../src/engine/matching-engine.js";
import { Fill } from "../src/engine/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function freshEngine() {
  return new MatchingEngine();
}

// ─── Basic placement ─────────────────────────────────────────────────────────

describe("limit order — resting (no match)", () => {
  it("posts a buy order onto the bid side", () => {
    const e = freshEngine();
    const r = e.placeLimitOrder("buy", 100, 1);
    expect(r.status).toBe("placed");
    expect(r.fills).toHaveLength(0);
    expect(r.order.remaining).toBe(1);

    const snap = e.getSnapshot();
    expect(snap.bids).toHaveLength(1);
    expect(snap.bids[0].price).toBe(100);
    expect(snap.bids[0].totalSize).toBe(1);
    expect(snap.asks).toHaveLength(0);
  });

  it("posts a sell order onto the ask side", () => {
    const e = freshEngine();
    const r = e.placeLimitOrder("sell", 101, 2);
    expect(r.status).toBe("placed");

    const snap = e.getSnapshot();
    expect(snap.asks).toHaveLength(1);
    expect(snap.asks[0].price).toBe(101);
    expect(snap.asks[0].totalSize).toBe(2);
    expect(snap.bids).toHaveLength(0);
  });

  it("rejects zero size", () => {
    const e = freshEngine();
    const r = e.placeLimitOrder("buy", 100, 0);
    expect(r.status).toBe("rejected");
  });

  it("rejects zero price", () => {
    const e = freshEngine();
    const r = e.placeLimitOrder("buy", 0, 1);
    expect(r.status).toBe("rejected");
  });
});

// ─── Full fill ───────────────────────────────────────────────────────────────

describe("limit order — full fill", () => {
  it("buy limit matches a resting ask at the same price", () => {
    const e = freshEngine();
    e.placeLimitOrder("sell", 100, 1);         // maker
    const r = e.placeLimitOrder("buy", 100, 1); // taker

    expect(r.status).toBe("filled");
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0].price).toBe(100);
    expect(r.fills[0].size).toBe(1);
    expect(r.fills[0].side).toBe("buy");

    const snap = e.getSnapshot();
    expect(snap.asks).toHaveLength(0);
    expect(snap.bids).toHaveLength(0);
  });

  it("sell limit matches a resting bid at the same price", () => {
    const e = freshEngine();
    e.placeLimitOrder("buy", 100, 1);
    const r = e.placeLimitOrder("sell", 100, 1);

    expect(r.status).toBe("filled");
    expect(r.fills[0].side).toBe("sell");
  });

  it("buy limit at higher price still fills at the maker's lower ask price", () => {
    const e = freshEngine();
    e.placeLimitOrder("sell", 99.5, 1);          // maker at 99.50
    const r = e.placeLimitOrder("buy", 100, 1);  // taker willing to pay up to 100

    expect(r.status).toBe("filled");
    expect(r.fills[0].price).toBe(99.5);   // price improvement: taker gets maker's price
  });

  it("buy limit below best ask does not match", () => {
    const e = freshEngine();
    e.placeLimitOrder("sell", 101, 1);
    const r = e.placeLimitOrder("buy", 100, 1);

    expect(r.status).toBe("placed");
    expect(r.fills).toHaveLength(0);
    const snap = e.getSnapshot();
    expect(snap.bids).toHaveLength(1);
    expect(snap.asks).toHaveLength(1);
  });
});

// ─── Partial fill ────────────────────────────────────────────────────────────

describe("partial fill", () => {
  it("taker larger than maker → partial fill, remainder rests", () => {
    const e = freshEngine();
    e.placeLimitOrder("sell", 100, 1);           // maker: 1 SOL
    const r = e.placeLimitOrder("buy", 100, 2.5); // taker: 2.5 SOL

    expect(r.status).toBe("partial");
    expect(r.fills[0].size).toBe(1);
    expect(r.order.remaining).toBe(1.5);

    const snap = e.getSnapshot();
    expect(snap.bids[0].totalSize).toBeCloseTo(1.5);
    expect(snap.asks).toHaveLength(0);
  });

  it("taker smaller than maker → full fill for taker, maker remainder rests", () => {
    const e = freshEngine();
    e.placeLimitOrder("sell", 100, 5);           // maker: 5 SOL
    const r = e.placeLimitOrder("buy", 100, 2);  // taker: 2 SOL

    expect(r.status).toBe("filled");
    expect(r.fills[0].size).toBe(2);

    const snap = e.getSnapshot();
    expect(snap.asks[0].totalSize).toBeCloseTo(3); // 5 - 2
  });
});

// ─── Price-time priority (FIFO within level) ──────────────────────────────────

describe("price-time priority", () => {
  it("fills older maker first when two orders sit at the same price", () => {
    const e = freshEngine();
    const r1 = e.placeLimitOrder("sell", 100, 1, "maker-A"); // arrives first
    const r2 = e.placeLimitOrder("sell", 100, 1, "maker-B"); // arrives second

    // Market buy of 1 should fill maker-A first
    const taker = e.placeMarketOrder("buy", 1);
    expect(taker.fills[0].makerOrderId).toBe(r1.order.id);

    // maker-B should still be resting
    expect(e.getOrder(r2.order.id)).toBeDefined();
    expect(e.getSnapshot().asks[0].totalSize).toBeCloseTo(1);
  });

  it("price priority: lower ask filled before higher ask", () => {
    const e = freshEngine();
    e.placeLimitOrder("sell", 101, 1, "expensive");
    const cheap = e.placeLimitOrder("sell", 100, 1, "cheap");

    const r = e.placeMarketOrder("buy", 1);
    expect(r.fills[0].makerOrderId).toBe(cheap.order.id);
    expect(r.fills[0].price).toBe(100);
  });

  it("buy taker sweeps multiple ask levels", () => {
    const e = freshEngine();
    e.placeLimitOrder("sell", 100, 1);
    e.placeLimitOrder("sell", 101, 1);
    e.placeLimitOrder("sell", 102, 1);

    const r = e.placeMarketOrder("buy", 2.5);
    expect(r.fills).toHaveLength(3);
    expect(r.fills[0].price).toBe(100);
    expect(r.fills[1].price).toBe(101);
    expect(r.fills[2].price).toBe(102);
    expect(r.fills[2].size).toBeCloseTo(0.5); // only 0.5 left at the third level
  });
});

// ─── Market orders ───────────────────────────────────────────────────────────

describe("market order", () => {
  it("rejected when book is empty", () => {
    const e = freshEngine();
    const r = e.placeMarketOrder("buy", 1);
    expect(r.status).toBe("rejected");
    expect(r.message).toMatch(/no liquidity/);
  });

  it("partial fill when insufficient depth", () => {
    const e = freshEngine();
    e.placeLimitOrder("sell", 100, 0.5);
    const r = e.placeMarketOrder("buy", 2);

    expect(r.status).toBe("partial");
    expect(r.fills[0].size).toBeCloseTo(0.5);
    // Market order does NOT rest — book should have no bids
    expect(e.getSnapshot().bids).toHaveLength(0);
  });

  it("rejects zero size", () => {
    const e = freshEngine();
    const r = e.placeMarketOrder("buy", 0);
    expect(r.status).toBe("rejected");
  });
});

// ─── Cancel order ────────────────────────────────────────────────────────────

describe("cancel order", () => {
  it("removes a resting buy order", () => {
    const e = freshEngine();
    const r = e.placeLimitOrder("buy", 100, 1);
    const cancel = e.cancelOrder(r.order.id);

    expect(cancel.success).toBe(true);
    expect(e.getSnapshot().bids).toHaveLength(0);
  });

  it("removes a resting sell order", () => {
    const e = freshEngine();
    const r = e.placeLimitOrder("sell", 100, 1);
    e.cancelOrder(r.order.id);
    expect(e.getSnapshot().asks).toHaveLength(0);
  });

  it("returns false for unknown order id", () => {
    const e = freshEngine();
    const cancel = e.cancelOrder(99999);
    expect(cancel.success).toBe(false);
  });

  it("cannot fill a cancelled order", () => {
    const e = freshEngine();
    const r = e.placeLimitOrder("sell", 100, 1);
    e.cancelOrder(r.order.id);

    const taker = e.placeMarketOrder("buy", 1);
    expect(taker.status).toBe("rejected"); // book is empty after cancel
  });

  it("cancelling one order at a level leaves others intact", () => {
    const e = freshEngine();
    const r1 = e.placeLimitOrder("sell", 100, 1);
    const r2 = e.placeLimitOrder("sell", 100, 2);

    e.cancelOrder(r1.order.id);

    const snap = e.getSnapshot();
    expect(snap.asks[0].totalSize).toBeCloseTo(2);
    expect(e.getOrder(r2.order.id)).toBeDefined();
  });
});

// ─── Snapshot correctness ────────────────────────────────────────────────────

describe("book snapshot", () => {
  it("bid/ask sorted correctly", () => {
    const e = freshEngine();
    e.placeLimitOrder("buy", 98, 1);
    e.placeLimitOrder("buy", 100, 1);
    e.placeLimitOrder("buy", 99, 1);
    e.placeLimitOrder("sell", 102, 1);
    e.placeLimitOrder("sell", 101, 1);
    e.placeLimitOrder("sell", 103, 1);

    const snap = e.getSnapshot();
    // bids descending
    expect(snap.bids.map((l) => l.price)).toEqual([100, 99, 98]);
    // asks ascending
    expect(snap.asks.map((l) => l.price)).toEqual([101, 102, 103]);
  });

  it("mid price and spread computed correctly", () => {
    const e = freshEngine();
    e.placeLimitOrder("buy", 100, 1);
    e.placeLimitOrder("sell", 102, 1);

    const snap = e.getSnapshot();
    expect(snap.bestBid).toBe(100);
    expect(snap.bestAsk).toBe(102);
    expect(snap.midPrice).toBe(101);
    expect(snap.spread).toBe(2);
  });

  it("null mid when book is empty", () => {
    const snap = freshEngine().getSnapshot();
    expect(snap.midPrice).toBeNull();
    expect(snap.spread).toBeNull();
  });

  it("aggregates sizes across multiple orders at the same level", () => {
    const e = freshEngine();
    e.placeLimitOrder("buy", 100, 1.5);
    e.placeLimitOrder("buy", 100, 2.0);
    e.placeLimitOrder("buy", 100, 0.5);

    expect(e.getSnapshot().bids[0].totalSize).toBeCloseTo(4.0);
    expect(e.getSnapshot().bids[0].orderCount).toBe(3);
  });
});

// ─── Events ──────────────────────────────────────────────────────────────────

describe("event emission", () => {
  it("emits 'fill' events for each matched pair", () => {
    const e = freshEngine();
    const receivedFills: Fill[] = [];
    e.on("fill", (f: Fill) => receivedFills.push(f));

    e.placeLimitOrder("sell", 100, 2);
    e.placeLimitOrder("sell", 101, 1);
    e.placeMarketOrder("buy", 2.5);

    expect(receivedFills).toHaveLength(2);
    expect(receivedFills[0].price).toBe(100);
    expect(receivedFills[1].price).toBe(101);
  });

  it("emits 'orderCancelled' when an order is cancelled", () => {
    const e = freshEngine();
    let cancelledId: number | null = null;
    e.on("orderCancelled", (o) => { cancelledId = o.id; });

    const r = e.placeLimitOrder("buy", 100, 1);
    e.cancelOrder(r.order.id);

    expect(cancelledId).toBe(r.order.id);
  });
});

// ─── Sequence numbers ────────────────────────────────────────────────────────

describe("sequence numbers", () => {
  it("sequence number increments after each state change", () => {
    const e = freshEngine();
    const s0 = e.getSnapshot().sequenceNumber;

    e.placeLimitOrder("buy", 100, 1);
    const s1 = e.getSnapshot().sequenceNumber;
    expect(s1).toBeGreaterThan(s0);

    e.placeLimitOrder("sell", 100, 1); // this crosses → fill
    const s2 = e.getSnapshot().sequenceNumber;
    expect(s2).toBeGreaterThan(s1);
  });
});
