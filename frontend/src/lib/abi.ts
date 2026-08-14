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

export const fluxaInvoiceAbi = [
  { type: 'error', name: 'InvoiceNotFound', inputs: [{ name: 'invoiceId', type: 'uint256' }] },
  { type: 'error', name: 'InvalidStatus', inputs: [{ name: 'invoiceId', type: 'uint256' }, { name: 'actual', type: 'uint8' }] },
  { type: 'error', name: 'AlreadyPaid', inputs: [{ name: 'invoiceId', type: 'uint256' }, { name: 'payer', type: 'address' }] },
  { type: 'error', name: 'IncorrectPaymentAmount', inputs: [{ name: 'expected', type: 'uint256' }, { name: 'received', type: 'uint256' }] },
  { type: 'error', name: 'MerchantIsPayer', inputs: [] },
  {
    type: 'function', name: 'createInvoice', stateMutability: 'nonpayable',
    inputs: [
      { name: 'payToken', type: 'address' }, { name: 'amount', type: 'uint256' },
      { name: 'dueAt', type: 'uint64' }, { name: 'paymentRef', type: 'bytes32' },
    ], outputs: [{ name: 'invoiceId', type: 'uint256' }],
  },
  {
    type: 'function', name: 'payInvoice', stateMutability: 'nonpayable',
    inputs: [{ name: 'invoiceId', type: 'uint256' }], outputs: [],
  },
  {
    type: 'function', name: 'getInvoice', stateMutability: 'view',
    inputs: [{ name: 'invoiceId', type: 'uint256' }],
    outputs: [{ name: 'invoice', type: 'tuple', components: [
      { name: 'merchant', type: 'address' }, { name: 'payToken', type: 'address' },
      { name: 'amount', type: 'uint256' }, { name: 'amountPaid', type: 'uint256' },
      { name: 'createdAt', type: 'uint64' }, { name: 'dueAt', type: 'uint64' },
      { name: 'paidAt', type: 'uint64' }, { name: 'payer', type: 'address' },
      { name: 'status', type: 'uint8' }, { name: 'rail', type: 'uint8' },
      { name: 'paymentRef', type: 'bytes32' },
    ] }],
  },
] as const;

export const fluxaSettlementAbi = [
  {
    type: 'function', name: 'settleInvoice', stateMutability: 'nonpayable',
    inputs: [{ name: 'invoiceId', type: 'uint256' }],
    outputs: [{ name: 'token', type: 'address' }, { name: 'amountOut', type: 'uint256' }],
  },
] as const;

export const fluxaInvoiceV2Abi = [
  { type: 'error', name: 'InvalidInvoice', inputs: [{ name: 'invoiceId', type: 'uint256' }] },
  { type: 'error', name: 'InvalidConfiguration', inputs: [] },
  { type: 'error', name: 'UnsupportedPaymentToken', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'InvalidStatus', inputs: [{ name: 'invoiceId', type: 'uint256' }, { name: 'status', type: 'uint8' }] },
  { type: 'error', name: 'MerchantIsPayer', inputs: [] },
  { type: 'error', name: 'SettlementNotConfigured', inputs: [] },
  { type: 'error', name: 'QuoteExceeded', inputs: [{ name: 'quoted', type: 'uint256' }, { name: 'maximum', type: 'uint256' }] },
  { type: 'error', name: 'IncorrectPaymentAmount', inputs: [{ name: 'expected', type: 'uint256' }, { name: 'received', type: 'uint256' }] },
  {
    type: 'function', name: 'createInvoice', stateMutability: 'nonpayable',
    inputs: [
      { name: 'payTokens', type: 'address[]' }, { name: 'settlementToken', type: 'address' },
      { name: 'usdAmount', type: 'uint256' }, { name: 'dueAt', type: 'uint64' },
      { name: 'paymentRef', type: 'bytes32' },
    ], outputs: [{ name: 'invoiceId', type: 'uint256' }],
  },
  {
    type: 'function', name: 'quotePaymentAmount', stateMutability: 'view',
    inputs: [{ name: 'invoiceId', type: 'uint256' }, { name: 'token', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'function', name: 'payInvoice', stateMutability: 'nonpayable',
    inputs: [
      { name: 'invoiceId', type: 'uint256' }, { name: 'token', type: 'address' },
      { name: 'maxAmount', type: 'uint256' },
    ], outputs: [],
  },
] as const;

export const fluxaSettlementV2Abi = [
  { type: 'error', name: 'InsufficientReserve', inputs: [{ name: 'token', type: 'address' }, { name: 'required', type: 'uint256' }, { name: 'available', type: 'uint256' }] },
  { type: 'error', name: 'AlreadySettled', inputs: [] },
  { type: 'error', name: 'SettlementNotReserved', inputs: [{ name: 'invoiceId', type: 'uint256' }] },
  {
    type: 'function', name: 'capacityFor', stateMutability: 'view',
    inputs: [{ name: 'invoiceId', type: 'uint256' }, { name: 'payToken', type: 'address' }],
    outputs: [
      { name: 'required', type: 'uint256' }, { name: 'available', type: 'uint256' },
      { name: 'sufficient', type: 'bool' },
    ],
  },
  {
    type: 'function', name: 'settleInvoice', stateMutability: 'nonpayable',
    inputs: [{ name: 'invoiceId', type: 'uint256' }], outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;
