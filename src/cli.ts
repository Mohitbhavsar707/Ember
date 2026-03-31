#!/usr/bin/env node
// src/cli.ts
//
// Interactive CLI for the Phoenix LOB engine.
// Run with:  node --loader ts-node/esm src/cli.ts
//
// Commands:
//   buy  <price> <size>   — place a limit buy
//   sell <price> <size>   — place a limit sell
//   mkt  buy|sell <size>  — place a market order
//   cancel <id>           — cancel an order
//   book  [depth]         — print the order book
//   fills [n]             — print recent fills
//   pos                   — print position summary
//   mm start|stop         — toggle the market maker
//   bench <n>             — run n random orders and report throughput
//   help                  — show this help
//   exit                  — quit

import * as readline from "readline";
import { MatchingEngine } from "./engine/matching-engine.js";
import { MarketMaker } from "./engine/market-maker.js";
import { Fill, PlaceOrderResult } from "./engine/types.js";

const engine = new MatchingEngine();
const mm = new MarketMaker(engine);
mm.seed();

const position = { size: 0, avgPrice: 0, realized: 0 };
const myOrderIds = new Set<number>();

// Track position from our own fills
engine.on("fill", (fill: Fill) => {
  if (myOrderIds.has(fill.makerOrderId) || myOrderIds.has(fill.takerOrderId)) {
    const isMaker = myOrderIds.has(fill.makerOrderId);
    const side = isMaker
      ? fill.side === "buy" ? "sell" : "buy"
      : fill.side;
    applyFill(fill, side);
  }
});

function applyFill(fill: Fill, side: "buy" | "sell"): void {
  if (side === "buy") {
    const cost = position.size * position.avgPrice + fill.size * fill.price;
    position.size = +(position.size + fill.size).toFixed(3);
    position.avgPrice = position.size > 0 ? cost / position.size : 0;
  } else {
    if (position.size > 0) {
      const closed = Math.min(fill.size, position.size);
      position.realized += closed * (fill.price - position.avgPrice);
      position.size = +(position.size - closed).toFixed(3);
      if (position.size < 0.0001) { position.size = 0; position.avgPrice = 0; }
    }
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const YELLOW = "\x1b[33m";
const PURPLE = "\x1b[35m";

const g = (s: string | number) => `${GREEN}${s}${RESET}`;
const r = (s: string | number) => `${RED}${s}${RESET}`;
const c = (s: string | number) => `${CYAN}${s}${RESET}`;
const y = (s: string | number) => `${YELLOW}${s}${RESET}`;
const d = (s: string | number) => `${DIM}${s}${RESET}`;
const b = (s: string | number) => `${BOLD}${s}${RESET}`;

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

function printBook(depth = 10): void {
  const snap = engine.getSnapshot(depth);
  console.log();
  console.log(`  ${b("SOL/USDC")}  ${d("─────────────────────────────")}`);
  console.log(`  ${d(pad("Price", 10))}${d(pad("Size", 10, true))}${d(pad("Total", 10, true))}`);
  console.log(`  ${d("─".repeat(30))}`);

  let cumAsk = 0;
  const askDisplay = [...snap.asks].reverse();
  for (const level of askDisplay) {
    cumAsk += level.totalSize;
    console.log(`  ${r(pad(level.price.toFixed(2), 10))}${pad(level.totalSize.toFixed(3), 10, true)}${d(pad(cumAsk.toFixed(3), 10, true))}`);
  }

  if (snap.midPrice !== null) {
    const spread = snap.spread !== null ? ` ${d(`spread ${snap.spread.toFixed(2)}`)}` : "";
    console.log(`  ${d("─".repeat(10))} ${b(snap.midPrice.toFixed(2))}${spread}`);
  }

  let cumBid = 0;
  for (const level of snap.bids) {
    cumBid += level.totalSize;
    console.log(`  ${g(pad(level.price.toFixed(2), 10))}${pad(level.totalSize.toFixed(3), 10, true)}${d(pad(cumBid.toFixed(3), 10, true))}`);
  }
  console.log();
}

function printResult(result: PlaceOrderResult): void {
  const o = result.order;
  const filled = o.size - o.remaining;

  if (result.status === "rejected") {
    console.log(`  ${r("✗ Rejected:")} ${result.message}`);
    return;
  }

  if (result.fills.length > 0) {
    const avgPrice = result.fills.reduce((s, f) => s + f.price * f.size, 0) /
                     result.fills.reduce((s, f) => s + f.size, 0);
    console.log(`  ${g("✓ Filled")} ${c(filled.toFixed(3))} SOL @ avg ${c(avgPrice.toFixed(2))} USDC`);
    for (const fill of result.fills) {
      console.log(`    ${d(`fill #${fill.tradeSeq}`)} ${c(fill.price.toFixed(2))} × ${c(fill.size.toFixed(3))}`);
    }
  }

  if (o.remaining > 0) {
    console.log(`  ${y("→ Resting")} ${c(o.remaining.toFixed(3))} SOL @ ${c((o.price ?? 0).toFixed(2))} ${d(`(id ${o.id})`)}`);
    myOrderIds.add(o.id);
  }
}

function printFills(n = 10): void {
  const fills = engine.getFills(n);
  if (fills.length === 0) { console.log(`  ${d("no fills yet")}`); return; }
  console.log();
  console.log(`  ${d(pad("seq", 5))}${d(pad("price", 10))}${d(pad("size", 10))}${d("side")}`);
  for (const f of fills) {
    const sideStr = f.side === "buy" ? g("buy") : r("sell");
    console.log(`  ${d(pad(f.tradeSeq, 5))}${pad(f.price.toFixed(2), 10)}${pad(f.size.toFixed(3), 10)}${sideStr}`);
  }
  console.log();
}

function printPosition(): void {
  const snap = engine.getSnapshot();
  const mid = snap.midPrice ?? position.avgPrice;
  const unrealized = position.size * (mid - position.avgPrice);
  const posColor = position.size > 0 ? g : position.size < 0 ? r : d;
  const pnlFmt = (n: number) => (n >= 0 ? g : r)(`${n >= 0 ? "+" : ""}${n.toFixed(2)}`);

  console.log();
  console.log(`  ${b("Position")}`);
  console.log(`  Size         ${posColor(position.size.toFixed(3) + " SOL")}`);
  console.log(`  Entry price  ${position.avgPrice ? c(position.avgPrice.toFixed(2)) : d("—")}`);
  console.log(`  Mark price   ${mid ? c(mid.toFixed(2)) : d("—")}`);
  console.log(`  Unrealized   ${pnlFmt(unrealized)} USDC`);
  console.log(`  Realized     ${pnlFmt(position.realized)} USDC`);
  console.log();
}

function bench(n: number): void {
  const start = performance.now();
  const sides: Array<"buy" | "sell"> = ["buy", "sell"];
  const base = engine.getSnapshot().midPrice ?? 142.50;

  for (let i = 0; i < n; i++) {
    const side = sides[i % 2];
    const price = +(base + (Math.random() - 0.5) * 2).toFixed(2);
    const size  = +(0.1 + Math.random() * 2).toFixed(3);
    engine.placeLimitOrder(side, price, size, "bench");
  }

  const elapsed = performance.now() - start;
  const opsPerSec = Math.round(n / (elapsed / 1000));
  console.log();
  console.log(`  ${b("Benchmark")} ${n.toLocaleString()} orders`);
  console.log(`  Elapsed   ${c(elapsed.toFixed(1))} ms`);
  console.log(`  Throughput ${c(opsPerSec.toLocaleString())} orders/sec`);
  console.log();
}

// ── REPL ────────────────────────────────────────────────────────────────────

const HELP = `
  ${b("Commands")}
  ${c("buy")}  <price> <size>      place limit buy
  ${c("sell")} <price> <size>      place limit sell
  ${c("mkt")}  buy|sell <size>     place market order
  ${c("cancel")} <id>              cancel a resting order
  ${c("book")} [depth]             print order book  (default depth: 8)
  ${c("fills")} [n]                print last n fills (default: 10)
  ${c("pos")}                      position & PnL
  ${c("mm")} start|stop            toggle market maker
  ${c("bench")} <n>                throughput benchmark (n orders)
  ${c("help")}                     show this help
  ${c("exit")}                     quit
`;

function printBanner(): void {
  console.log();
  console.log(`  ${PURPLE}${BOLD}Phoenix LOB${RESET}  ${d("SOL/USDC · price-time priority matching engine")}`);
  console.log(`  ${d("Market maker seeded. Type 'help' for commands.")}`);
  console.log();
}

async function main(): Promise<void> {
  printBanner();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${PURPLE}lob${RESET}> `,
  });

  rl.prompt();

  rl.on("line", (line) => {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    const cmd = parts[0]?.toLowerCase();

    try {
      if (!cmd) {
        // empty line — do nothing
      } else if (cmd === "buy") {
        const [, price, size] = parts;
        const result = engine.placeLimitOrder("buy", parseFloat(price), parseFloat(size), "cli");
        printResult(result);
      } else if (cmd === "sell") {
        const [, price, size] = parts;
        const result = engine.placeLimitOrder("sell", parseFloat(price), parseFloat(size), "cli");
        printResult(result);
      } else if (cmd === "mkt") {
        const [, side, size] = parts;
        const result = engine.placeMarketOrder(side as "buy" | "sell", parseFloat(size), "cli");
        printResult(result);
      } else if (cmd === "cancel") {
        const result = engine.cancelOrder(parseInt(parts[1]));
        console.log(result.success
          ? `  ${g("✓")} ${result.message}`
          : `  ${r("✗")} ${result.message}`);
      } else if (cmd === "book") {
        printBook(parseInt(parts[1]) || 8);
      } else if (cmd === "fills") {
        printFills(parseInt(parts[1]) || 10);
      } else if (cmd === "pos") {
        printPosition();
      } else if (cmd === "mm") {
        if (parts[1] === "start") { mm.start(); console.log(`  ${g("market maker started")}`); }
        else { mm.stop(); console.log(`  ${y("market maker stopped")}`); }
      } else if (cmd === "bench") {
        bench(parseInt(parts[1]) || 10000);
      } else if (cmd === "help") {
        console.log(HELP);
      } else if (cmd === "exit" || cmd === "quit") {
        mm.stop(); rl.close(); process.exit(0);
      } else {
        console.log(`  ${r("unknown command:")} ${cmd}. Type ${c("help")} for a list.`);
      }
    } catch (err) {
      console.log(`  ${r("error:")} ${(err as Error).message}`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    mm.stop();
    process.exit(0);
  });
}

main();
