/**
 * Minimal ABIs, written as const so viem/wagmi infer argument and return types.
 *
 * Only the functions Fluxa actually calls are declared. Full artifacts come
 * from the contracts workspace once FluxaInvoice is deployed.
 */

export const erc20Abi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/**
 * FTSOv2 price reads.
 *
 * getFeedById returns (value, decimals, timestamp). `decimals` is int8 and
 * differs per feed — XRP/USD reports 6, FLR/USD reports 8. Always divide by the
 * returned exponent.
 */
export const ftsoV2Abi = [
  {
    type: 'function',
    name: 'getFeedById',
    stateMutability: 'view',
    inputs: [{ name: 'feedId', type: 'bytes21' }],
    outputs: [
      { name: 'value', type: 'uint256' },
      { name: 'decimals', type: 'int8' },
      { name: 'timestamp', type: 'uint64' },
    ],
  },
  {
    type: 'function',
    name: 'getFeedsById',
    stateMutability: 'view',
    inputs: [{ name: 'feedIds', type: 'bytes21[]' }],
    outputs: [
      { name: 'values', type: 'uint256[]' },
      { name: 'decimals', type: 'int8[]' },
      { name: 'timestamp', type: 'uint64' },
    ],
  },
] as const;
