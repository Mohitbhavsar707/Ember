// src/engine/types.ts
// All domain types for the Phoenix LOB engine.
// Designed to mirror what a Solana on-chain account layout would look like.

export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";
export type OrderStatus = "open" | "filled" | "partial" | "cancelled";

export interface Order {
  readonly id: number;
  readonly clientOrderId: string; // user-supplied idempotency key
  readonly side: Side;
  readonly type: OrderType;
  readonly price: number | null; // null for market orders
  readonly size: number; // original size
  remaining: number; // mutable — decremented as fills happen
  status: OrderStatus;
  readonly timestamp: number; // ms since epoch (time-priority tiebreak)
}

export interface Fill {
  readonly fillId: number;
  readonly tradeSeq: number; // global trade sequence number
  readonly makerOrderId: number;
  readonly takerOrderId: number;
  readonly side: Side; // aggressor side
  readonly price: number;
  readonly size: number;
  readonly timestamp: number;
}

export interface PriceLevel {
  readonly price: number;
  readonly totalSize: number; // sum of remaining sizes at this level
  readonly orderCount: number;
}

export interface BookSnapshot {
  readonly bids: PriceLevel[]; // descending price
  readonly asks: PriceLevel[]; // ascending price
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly midPrice: number | null;
  readonly spread: number | null;
  readonly lastTradePrice: number | null;
  readonly sequenceNumber: number;
}

export interface PlaceOrderResult {
  readonly order: Order;
  readonly fills: Fill[];
  readonly status: "placed" | "filled" | "partial" | "rejected";
  readonly message?: string;
}

export interface CancelOrderResult {
  readonly success: boolean;
  readonly orderId: number;
  readonly message: string;
}
