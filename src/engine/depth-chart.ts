// src/engine/depth-chart.ts
//
// Computes cumulative depth curve data from a BookSnapshot.
// Used by both the browser canvas renderer and any analytics pipeline.
//
// A depth chart shows the *total* quantity available at each price point
// cumulatively — so you can see at a glance how much size you'd need to
// move the market by N ticks.

import { PriceLevel } from "./types.js";

export interface DepthPoint {
  readonly price: number;
  readonly cumulativeSize: number;
  readonly side: "bid" | "ask";
}

export interface DepthChartData {
  readonly bids: DepthPoint[];    // descending price, ascending cumSize
  readonly asks: DepthPoint[];    // ascending price, ascending cumSize
  readonly midPrice: number | null;
  readonly maxCumSize: number;    // for normalising the y-axis
  /** Price range to display: [midPrice - window, midPrice + window] */
  readonly displayWindow: number;
}

/**
 * Build depth chart data from sorted price levels.
 *
 * @param bids - descending price order (as returned by getSnapshot)
 * @param asks - ascending price order
 * @param windowBps - how many basis points either side of mid to include
 */
export function buildDepthChart(
  bids: PriceLevel[],
  asks: PriceLevel[],
  midPrice: number | null,
  windowBps = 50
): DepthChartData {
  // Cumulate bids (descending → cumulate from best bid outward)
  const bidPoints: DepthPoint[] = [];
  let bidCum = 0;
  for (const level of bids) {
    bidCum += level.totalSize;
    bidPoints.push({ price: level.price, cumulativeSize: bidCum, side: "bid" });
  }

  // Cumulate asks (ascending → cumulate from best ask outward)
  const askPoints: DepthPoint[] = [];
  let askCum = 0;
  for (const level of asks) {
    askCum += level.totalSize;
    askPoints.push({ price: level.price, cumulativeSize: askCum, side: "ask" });
  }

  const maxCumSize = Math.max(bidCum, askCum, 0.01);

  // Compute display window in price units
  const displayWindow = midPrice ? midPrice * (windowBps / 10000) : 1;

  return { bids: bidPoints, asks: askPoints, midPrice, maxCumSize, displayWindow };
}

/**
 * Given a depth chart and a target price, returns the cumulative size
 * available up to that price (i.e. "how much can I buy up to $X?").
 */
export function sizeAtPrice(
  data: DepthChartData,
  targetPrice: number,
  side: "bid" | "ask"
): number {
  const points = side === "ask" ? data.asks : data.bids;
  const inRange = side === "ask"
    ? points.filter((p) => p.price <= targetPrice)
    : points.filter((p) => p.price >= targetPrice);
  return inRange.length > 0 ? inRange[inRange.length - 1].cumulativeSize : 0;
}

/**
 * Estimate the average fill price for a given market order size.
 * Returns null if insufficient depth.
 */
export function estimateFillPrice(
  data: DepthChartData,
  size: number,
  side: "bid" | "ask"
): { avgPrice: number; slippageBps: number } | null {
  const points = side === "ask" ? data.asks : [...data.bids].reverse();
  const mid = data.midPrice;
  if (!mid || points.length === 0) return null;

  let remaining = size;
  let costBasis = 0;

  for (const pt of points) {
    // infer level size from diff between consecutive cum values
    const levelSize = pt.cumulativeSize - (costBasis > 0 ? costBasis : 0);
    // This is simplified — ideally we'd store per-level sizes too
    const filled = Math.min(remaining, pt.cumulativeSize);
    remaining -= filled;
    costBasis = filled * pt.price;
    if (remaining <= 0) break;
  }

  if (remaining > 0) return null; // insufficient depth

  const avgPrice = costBasis / size;
  const slippageBps = Math.abs((avgPrice - mid) / mid) * 10000;
  return { avgPrice, slippageBps };
}
