# Phoenix LOB

A **limit order book matching engine** built in TypeScript inspired by [Ellipsis Labs'](https://ellipsis.trade) Phoenix on Solana.

## What's inside

```
src/
  engine/
    types.ts           — Domain model: Order, Fill, BookSnapshot, etc.
    matching-engine.ts — Price-time priority LOB (limit + market orders, cancel)
    market-maker.ts    — Simulated MM for demo/dev purposes
  server/
    index.ts           — Express REST API + WebSocket broadcast server
public/
  index.html           — Real-time trading terminal UI
tests/
  matching-engine.test.ts — 25+ unit tests covering all matching scenarios
```

## Matching engine design

- **Price-time priority** (FIFO within a price level)
- **Limit orders** match immediately against resting contra-side orders at equal-or-better prices, remainder rests on the book
- **Market orders** sweep the book until filled; unfilled remainder is *not* posted (IOC semantics)
- **Cancel** is O(n) within a level but O(1) level lookup via `Map<price, Order[]>`
- All prices rounded to **2 decimal places**, sizes to **3** — mirrors on-chain fixed-point arithmetic
- EventEmitter interface: `fill`, `orderPlaced`, `orderCancelled` events enable reactive downstream systems (WebSocket broadcasts, PnL tracking, etc.)

## Quick start

**Requirements:** Node.js 18+, npm — that's it. No paid services.

```bash
git clone <repo>
cd phoenix-lob
npm install
npm run dev        # starts server at http://localhost:3000
```

Open `http://localhost:3000` in your browser for the live trading terminal.

## Running tests

```bash
npm test                  # run all tests once
npm run test:watch        # watch mode
npm run test:coverage     # coverage report
```

## REST API

```bash
# Place a limit order
curl -X POST http://localhost:3000/orders/limit \
  -H 'Content-Type: application/json' \
  -d '{"side":"buy","price":142.50,"size":1.0}'

# Place a market order
curl -X POST http://localhost:3000/orders/market \
  -H 'Content-Type: application/json' \
  -d '{"side":"sell","size":0.5}'

# Cancel an order
curl -X DELETE http://localhost:3000/orders/42

# Get book snapshot
curl http://localhost:3000/book

# Get recent fills
curl http://localhost:3000/fills
```

## WebSocket protocol

Connect to `ws://localhost:3000`, then:

```js
// Subscribe to live book updates
ws.send(JSON.stringify({ type: "subscribe" }))

// Place a limit order
ws.send(JSON.stringify({ type: "limit", side: "buy", price: 142.50, size: 1.0 }))

// Place a market order
ws.send(JSON.stringify({ type: "market", side: "sell", size: 0.5 }))

// Cancel
ws.send(JSON.stringify({ type: "cancel", orderId: 42 }))
```

Server emits:
- `{ type: "snapshot", bids, asks, midPrice, spread, ... }` — full book after each state change
- `{ type: "fill", fill }` — broadcast on every trade
- `{ type: "ack", result }` — response to your order

## Extending toward production

| Layer | Next steps |
|-------|-----------|
| Engine | Port to Rust with `BTreeMap<u64, VecDeque<Order>>` for O(log n) level iteration |
| Persistence | Write fill events to an append-only log (Kafka / Postgres WAL) |
| On-chain | Encode as a Solana program; use discriminants + zero-copy accounts |
| Risk | Add pre-trade checks: max order size, position limits, margin checks |
| Perf | Replace `Date.now()` timestamps with Solana cluster time / slot |

## Tech stack

| Tool | Why |
|------|-----|
| TypeScript 5 | Strong types catch domain bugs at compile time |
| Vitest | Fast, ESM-native test runner |
| Express | Minimal HTTP layer for REST endpoints |
| ws | Lightweight WebSocket server for live updates |

All free, open-source.
