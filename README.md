# Fluxa

**Pay with any supported asset. Settle in the one you want.**

Fluxa is a crypto invoicing and settlement product built on [Flare](https://flare.network).
A merchant issues an invoice denominated in USD and chooses the asset they want to be paid
in. The customer pays with whichever supported asset they hold. Fluxa prices the payment
against Flare's decentralized oracle, verifies it, and settles the merchant in their chosen
asset.

The separation of **payment asset** from **settlement asset** is the product.

> Built for the **Flare Summer Signal** hackathon — Track 1, *Interoperable Asset Products*.
> Deployed on the **Coston2** testnet. All assets are test assets; no real funds are at risk.

---

## Why Flare

Fluxa is not an invoicing app with a wallet button bolted on. Remove Flare and the product
stops existing:

| Fluxa needs | Flare provides |
| --- | --- |
| An XRP-derived asset usable in EVM contracts | **FAssets / FXRP** |
| Trustworthy USD pricing for volatile assets | **FTSOv2** |
| Proof that an off-chain payment really happened | **FDC** |
| Contract execution and settlement | **Flare EVM / Coston2** |

## Two payment rails

Fluxa accepts payment two ways. They share one invoice state machine.

**Rail A — on-Flare (FXRP / USDT0).** The customer pays an ERC-20 on Coston2. The contract
observes the transfer directly. Fast, no external dependency; this is the reliable demo path.

**Rail B — cross-chain (native XRP on XRPL).** The customer pays real XRP on the XRP Ledger
testnet, tagging the invoice. The **Flare Data Connector** attests that payment, and the proof
is verified on Coston2 before the invoice moves to `PAID`.

Rail B is where FDC does genuine work: the payment happens on a chain the contract cannot see.
Rail A deliberately does *not* use FDC — attesting a Coston2 transaction to a Coston2 contract
would be theatre, since the transfer is already in the contract's own state.

## Architecture

```
Merchant                                  Customer
   │  createInvoice($500, settle: USDT0)      │  opens /pay/:id
   ▼                                          ▼
┌──────────────────────────────────────────────────────┐
│                  Fluxa (Coston2)                     │
│                                                      │
│   InvoiceRegistry ──────────► SettlementVault        │
│         ▲                            │               │
│         │ price                      │ settle        │
│    ┌────┴─────┐                      ▼               │
│    │  FTSOv2  │                  Merchant (USDT0)    │
│    └──────────┘                                      │
│         ▲                                            │
│         │ proof (Rail B only)                        │
│    ┌────┴─────┐                                      │
│    │   FDC    │◄──── XRP Ledger testnet payment      │
│    └──────────┘                                      │
└──────────────────────────────────────────────────────┘
```

## Repository layout

```
fluxa/
├── contracts/     Solidity + Hardhat. Invoice, settlement, Flare integration.
├── frontend/      React + Vite + TypeScript + Tailwind. Merchant and checkout UI.
├── database/      Supabase/PostgreSQL schema and Row Level Security policies.
├── docs/          Design and validation records.
└── README.md
```

## Getting started

Requires Node.js 20+.

```bash
cp .env.example .env        # then fill in the values

cd contracts && npm install
npx hardhat compile
npx hardhat test

cd ../frontend && npm install
npm run dev
```

Get testnet assets (C2FLR for gas, plus FXRP and USDT0) from the
[Coston2 faucet](https://faucet.flare.network/coston2).

## Coston2 deployment

Validated on-chain during Phase 0 — see [`docs/PHASE-0-FLARE-VALIDATION.md`](docs/PHASE-0-FLARE-VALIDATION.md)
for the full record and how each value was verified.

| Contract | Address |
| --- | --- |
| FXRP (`FTestXRP`, 6 dp) | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| USDT0 (`USD₮0`, 6 dp) | `0xC1A5B41512496B80903D1f32d6dEa3a73212E71F` |
| FlareContractRegistry | `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` |
| Fluxa `InvoiceRegistry` | _pending deployment_ |
| Fluxa `SettlementVault` | _pending deployment_ |

## Status

Coston2 testnet MVP, under active development for the hackathon. Not audited. Not for
production use or real funds.

## License

MIT
