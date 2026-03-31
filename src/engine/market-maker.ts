// src/engine/market-maker.ts
//
// A simple simulated market maker that quotes a two-sided spread and
// occasionally sends market orders to create realistic price action.
// Used only in dev/demo mode — not part of the core engine.

import { MatchingEngine } from "./matching-engine.js";

export interface MarketMakerConfig {
  basePrice: number;
  tickSize: number;
  spreadBps: number; // half-spread in basis points
  maxSkew: number; // max inventory skew before widening spread
  quoteSizes: number[]; // sizes to quote at successive levels
  updateIntervalMs: number;
}

export const DEFAULT_CONFIG: MarketMakerConfig = {
  basePrice: 142.50,
  tickSize: 0.05,
  spreadBps: 5, // 5 bps each side = ~0.07 USDC at 142
  maxSkew: 10,
  quoteSizes: [2.5, 4.0, 6.5, 8.0, 12.0],
  updateIntervalMs: 1200,
};

export class MarketMaker {
  private engine: MatchingEngine;
  private config: MarketMakerConfig;
  private myOrderIds: Set<number> = new Set();
  private midPrice: number;
  private inventory = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(engine: MatchingEngine, config = DEFAULT_CONFIG) {
    this.engine = engine;
    this.config = config;
    this.midPrice = config.basePrice;

    // Track our own fills so we can update inventory
    engine.on("fill", (fill) => {
      if (this.myOrderIds.has(fill.makerOrderId)) {
        this.inventory += fill.side === "sell" ? -fill.size : fill.size;
      }
    });
  }

  seed(): void {
    // Populate an initial book with realistic depth
    const { basePrice, tickSize, quoteSizes } = this.config;
    for (let i = 0; i < quoteSizes.length; i++) {
      const askPrice = this._snap(basePrice + tickSize * (i + 1));
      const bidPrice = this._snap(basePrice - tickSize * (i + 1));
      const sz = quoteSizes[i];
      // Split each level into 1-3 resting orders to simulate multiple participants
      const parts = Math.ceil(Math.random() * 2) + 1;
      for (let p = 0; p < parts; p++) {
        const partSz = this._roundSize((sz / parts) * (0.75 + Math.random() * 0.5));
        const ar = this.engine.placeLimitOrder("sell", askPrice, partSz, "mm");
        const br = this.engine.placeLimitOrder("buy", bidPrice, partSz, "mm");
        this.myOrderIds.add(ar.order.id);
        this.myOrderIds.add(br.order.id);
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), this.config.updateIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private _tick(): void {
    // Small random walk on the mid price
    const drift = (Math.random() - 0.48) * this.config.tickSize * 1.5;
    this.midPrice = this._snap(this.midPrice + drift);

    // Inventory-adjusted spread: widen when skewed
    const skewFactor = Math.min(1 + Math.abs(this.inventory) / this.config.maxSkew, 2.5);
    const halfSpreadUsdc = this.midPrice * (this.config.spreadBps / 10000) * skewFactor;
    const halfSpreadTicks = Math.max(1, Math.round(halfSpreadUsdc / this.config.tickSize));

    // Place fresh quotes at a couple of levels
    const levels = Math.min(2, this.config.quoteSizes.length);
    for (let i = 0; i < levels; i++) {
      const askPrice = this._snap(this.midPrice + this.config.tickSize * (halfSpreadTicks + i));
      const bidPrice = this._snap(this.midPrice - this.config.tickSize * (halfSpreadTicks + i));
      const sz = this._roundSize(
        this.config.quoteSizes[i] * (0.6 + Math.random() * 0.8)
      );

      const ar = this.engine.placeLimitOrder("sell", askPrice, sz, "mm");
      const br = this.engine.placeLimitOrder("buy", bidPrice, sz, "mm");
      this.myOrderIds.add(ar.order.id);
      this.myOrderIds.add(br.order.id);
    }

    // Occasionally simulate an informed trader hitting the book
    if (Math.random() < 0.3) {
      const side = Math.random() < 0.5 ? "buy" : "sell";
      const mktSize = this._roundSize(0.3 + Math.random() * 1.5);
      this.engine.placeMarketOrder(side, mktSize, "taker");
    }
  }

  private _snap(price: number): number {
    const ticks = Math.round(price / this.config.tickSize);
    return Math.round(ticks * this.config.tickSize * 100) / 100;
  }

  private _roundSize(n: number): number {
    return Math.round(n * 1000) / 1000;
  }
}
