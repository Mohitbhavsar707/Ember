// tests/stress.test.ts
//
// Stress tests and property-based invariant checks.
// These verify correctness under high volume and catch edge cases
// that unit tests miss (e.g. floating-point drift, level cleanup).

import { describe, it, expect, beforeEach } from "vitest";
import { MatchingEngine } from "../src/engine/matching-engine.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function freshEngine() {
  return new MatchingEngine();
}

function seedBook(e: MatchingEngine, levels = 10, basePrice = 100): void {
  for (let i = 1; i <= levels; i++) {
    e.placeLimitOrder("sell", +(basePrice + i * 0.05).toFixed(2), +(1 + Math.random() * 3).toFixed(3));
    e.placeLimitOrder("buy",  +(basePrice - i * 0.05).toFixed(2), +(1 + Math.random() * 3).toFixed(3));
  }
}

// ─── Invariant: book never crosses ──────────────────────────────────────────

describe("book crossing invariant", () => {
  it("bestBid is always < bestAsk after any sequence of orders", () => {
    const e = freshEngine();
    const prices = [100, 100.5, 101, 99.5, 100.25, 101.5, 99, 102];
    for (const p of prices) {
      e.placeLimitOrder("buy",  p, 1);
      e.placeLimitOrder("sell", p, 1);
    }
    const snap = e.getSnapshot();
    if (snap.bestBid !== null && snap.bestAsk !== null) {
      expect(snap.bestBid).toBeLessThan(snap.bestAsk);
    }
  });

  it("remains uncrossed after 500 random limit orders", () => {
    const e = freshEngine();
    const base = 100;
    for (let i = 0; i < 500; i++) {
      const side = Math.random() < 0.5 ? "buy" : "sell";
      const price = +(base + (Math.random() - 0.5) * 4).toFixed(2);
      const size  = +(0.1 + Math.random() * 2).toFixed(3);
      e.placeLimitOrder(side, price, size);
    }
    const snap = e.getSnapshot();
    if (snap.bestBid !== null && snap.bestAsk !== null) {
      expect(snap.bestBid).toBeLessThan(snap.bestAsk);
    }
  });
});

// ─── Invariant: conservation of size ────────────────────────────────────────

describe("size conservation", () => {
  it("total filled = taker size when fully matched", () => {
    const e = freshEngine();
    // Place 3 SOL of asks spread across levels
    e.placeLimitOrder("sell", 100.10, 1.0);
    e.placeLimitOrder("sell", 100.15, 1.0);
    e.placeLimitOrder("sell", 100.20, 1.0);

    // Market buy of 2.5 SOL
    const result = e.placeMarketOrder("buy", 2.5);
    const totalFilled = result.fills.reduce((s, f) => s + f.size, 0);
    expect(totalFilled).toBeCloseTo(2.5, 2);
  });

  it("maker remaining decrements correctly across partial fills", () => {
    const e = freshEngine();
    const maker = e.placeLimitOrder("sell", 100, 5.0);
    e.placeMarketOrder("buy", 1.5);
    e.placeMarketOrder("buy", 2.0);

    // 3.5 filled, 1.5 should remain
    const snap = e.getSnapshot();
    expect(snap.asks[0]?.totalSize).toBeCloseTo(1.5, 2);
  });

  it("no size created or destroyed across a full match cycle", () => {
    const e = freshEngine();
    // Place 10 SOL of bids
    for (let i = 0; i < 10; i++) {
      e.placeLimitOrder("buy", 100, 1.0);
    }
    const snapBefore = e.getSnapshot();
    const totalBidSizeBefore = snapBefore.bids.reduce((s, l) => s + l.totalSize, 0);
    expect(totalBidSizeBefore).toBeCloseTo(10, 2);

    // Sell 10 SOL at market
    const result = e.placeMarketOrder("sell", 10.0);
    const totalFilled = result.fills.reduce((s, f) => s + f.size, 0);
    expect(totalFilled).toBeCloseTo(10, 2);

    // Book should be empty
    const snapAfter = e.getSnapshot();
    expect(snapAfter.bids).toHaveLength(0);
    expect(snapAfter.asks).toHaveLength(0);
  });
});

// ─── Invariant: level cleanup ────────────────────────────────────────────────

describe("empty level cleanup", () => {
  it("fully consumed levels are removed from the map", () => {
    const e = freshEngine();
    e.placeLimitOrder("sell", 100, 1.0);
    e.placeLimitOrder("sell", 101, 1.0);

    e.placeMarketOrder("buy", 1.0); // consumes level 100

    const snap = e.getSnapshot();
    const prices = snap.asks.map((l) => l.price);
    expect(prices).not.toContain(100);   // cleaned up
    expect(prices).toContain(101);       // still there
  });

  it("level with multiple orders is only removed when all are filled", () => {
    const e = freshEngine();
    e.placeLimitOrder("sell", 100, 1.0);
    e.placeLimitOrder("sell", 100, 1.0);
    e.placeLimitOrder("sell", 100, 1.0);

    e.placeMarketOrder("buy", 2.0); // fills 2 of the 3 orders

    const snap = e.getSnapshot();
    expect(snap.asks).toHaveLength(1);
    expect(snap.asks[0].price).toBe(100);
    expect(snap.asks[0].totalSize).toBeCloseTo(1.0, 2);
    expect(snap.asks[0].orderCount).toBe(1);
  });
});

// ─── High-volume fill events ─────────────────────────────────────────────────

describe("fill event correctness under load", () => {
  it("every fill event has a valid makerOrderId and takerOrderId", () => {
    const e = freshEngine();
    seedBook(e, 10);

    const badFills: unknown[] = [];
    e.on("fill", (fill) => {
      if (!fill.makerOrderId || !fill.takerOrderId) badFills.push(fill);
      if (fill.size <= 0) badFills.push(fill);
      if (fill.price <= 0) badFills.push(fill);
    });

    for (let i = 0; i < 50; i++) {
      const side = i % 2 === 0 ? "buy" : "sell";
      e.placeMarketOrder(side, +(0.5 + Math.random() * 2).toFixed(3));
      // Re-seed every 5 iterations so book doesn't run dry
      if (i % 5 === 0) seedBook(e, 3);
    }

    expect(badFills).toHaveLength(0);
  });

  it("fill tradeSeq numbers are strictly monotonically increasing", () => {
    const e = freshEngine();
    seedBook(e, 20);

    const seqs: number[] = [];
    e.on("fill", (fill) => seqs.push(fill.tradeSeq));

    for (let i = 0; i < 30; i++) {
      e.placeMarketOrder(i % 2 === 0 ? "buy" : "sell", 0.5);
      if (i % 3 === 0) seedBook(e, 5);
    }

    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});

// ─── Throughput benchmark ────────────────────────────────────────────────────

describe("throughput", () => {
  it("processes 10,000 limit orders in under 200ms", () => {
    const e = freshEngine();
    const base = 100;
    const n = 10_000;
    const start = performance.now();

    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? "buy" : "sell" as "buy" | "sell";
      const price = +(base + (Math.random() - 0.5) * 2).toFixed(2);
      const size  = +(0.1 + Math.random()).toFixed(3);
      e.placeLimitOrder(side, price, size);
    }

    const elapsed = performance.now() - start;
    console.log(`    10k orders in ${elapsed.toFixed(1)}ms (${Math.round(n / elapsed * 1000).toLocaleString()} orders/sec)`);
    expect(elapsed).toBeLessThan(200);
  });

  it("processes 1,000 market orders sweeping a deep book in under 100ms", () => {
    const e = freshEngine();
    // Seed a deep book
    for (let i = 1; i <= 50; i++) {
      e.placeLimitOrder("sell", +(100 + i * 0.05).toFixed(2), 10);
      e.placeLimitOrder("buy",  +(100 - i * 0.05).toFixed(2), 10);
    }

    const n = 1_000;
    const start = performance.now();

    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? "buy" : "sell" as "buy" | "sell";
      e.placeMarketOrder(side, +(0.1 + Math.random() * 0.5).toFixed(3));
      // Reseed every 10 to keep book alive
      if (i % 10 === 0) {
        e.placeLimitOrder("sell", +(100.5 + Math.random()).toFixed(2), 5);
        e.placeLimitOrder("buy",  +(99.5 - Math.random()).toFixed(2), 5);
      }
    }

    const elapsed = performance.now() - start;
    console.log(`    1k market orders in ${elapsed.toFixed(1)}ms (${Math.round(n / elapsed * 1000).toLocaleString()} ops/sec)`);
    expect(elapsed).toBeLessThan(100);
  });
});

// ─── Cancel safety ───────────────────────────────────────────────────────────

describe("cancel safety under concurrent-style ops", () => {
  it("cancelling already-filled order returns false, not error", () => {
    const e = freshEngine();
    const maker = e.placeLimitOrder("sell", 100, 1);
    e.placeMarketOrder("buy", 1); // fully fills maker

    const cancel = e.cancelOrder(maker.order.id);
    expect(cancel.success).toBe(false);
  });

  it("double-cancel is safe", () => {
    const e = freshEngine();
    const r = e.placeLimitOrder("buy", 100, 1);
    e.cancelOrder(r.order.id);
    const c2 = e.cancelOrder(r.order.id);
    expect(c2.success).toBe(false);
    expect(e.getSnapshot().bids).toHaveLength(0);
  });

  it("cancel then place at same price level works correctly", () => {
    const e = freshEngine();
    const r1 = e.placeLimitOrder("sell", 100, 1);
    e.cancelOrder(r1.order.id);
    const r2 = e.placeLimitOrder("sell", 100, 2);

    expect(e.getSnapshot().asks[0].totalSize).toBeCloseTo(2);
    expect(e.getOrder(r2.order.id)).toBeDefined();
  });
});
