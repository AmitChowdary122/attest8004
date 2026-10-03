/**
 * Blocks per eth_getLogs query. Monad testnet's RPC refuses a range with toBlock - fromBlock > 100
 * (error -32614 "eth_getLogs is limited to a 100 range", measured 3 Oct 2026), so 100 blocks
 * (toBlock - fromBlock = 99) stays inside the limit.
 */
export const MAX_LOG_BLOCK_RANGE = 100n;

/** Splits [from, to] into consecutive windows of at most `maxBlocks` blocks, in order. */
export function blockWindows(
  from: bigint,
  to: bigint,
  maxBlocks: bigint = MAX_LOG_BLOCK_RANGE,
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (maxBlocks < 1n) throw new RangeError(`maxBlocks must be at least 1, got ${maxBlocks}`);
  const windows: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let fromBlock = from; fromBlock <= to; fromBlock += maxBlocks) {
    const end = fromBlock + maxBlocks - 1n;
    windows.push({ fromBlock, toBlock: end < to ? end : to });
  }
  return windows;
}
