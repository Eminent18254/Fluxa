# Phase 0 — Flare Technical Validation

**Network:** Flare Coston2 testnet (chain 114)
**Validated:** 11 August 2026
**Method:** direct `eth_call` against `https://coston2-api.flare.network/ext/C/rpc`, plus current docs at `dev.flare.network`

Nothing in this document was written from memory. Every address was confirmed to
have deployed code, every decimal value was read from the token contract, and
every price was fetched from FTSOv2 on a live block. The checks are reproducible:

```bash
cd contracts && npm run check:flare
```

That script asserts this entire document against the live chain. If Flare
upgrades a contract or a feed changes shape, it fails loudly instead of letting
a stale assumption reach production.

---

## 1. Why this phase existed

Fluxa's design leans on four Flare systems: FAssets/FXRP, FTSOv2, FDC, and the
Coston2 EVM. Each carries assumptions that are cheap to verify now and expensive
to discover during the demo. Three of those assumptions turned out to be wrong.

## 2. Findings that changed the design

### 2.1 FXRP and USDT0 use 6 decimals, not 18

`FTestXRP.decimals()` returns **6**. `USDT0.decimals()` returns **6**.

Most ERC-20 tutorial code assumes 18. Any hardcoded `parseEther`/`1e18` in
Fluxa's payment path would misprice an invoice by a factor of 10^12 — a $500
invoice would request 497 *trillion* base units. Amounts are therefore always
handled in base units with decimals read from `config/flare.ts`, never inline.

### 2.2 FTSOv2 decimals differ per feed

| Feed | Decimals | Price at validation |
| --- | --- | --- |
| XRP/USD | 6 | $1.004879 |
| USDT/USD | 6 | $0.998950 |
| USDC/USD | 6 | $0.999928 |
| FLR/USD | **8** | $0.006100 |

`getFeedById` returns `(value, decimals, timestamp)`. The exponent is part of the
response and varies between feeds on the same oracle. Code must divide by the
returned `decimals`, never by a constant.

The project doc's worked example (§6.7) assumes `1 FXRP = $2.50`. Live price is
~$1.00 — about 2.5× off. Fine as illustration, fatal as a constant.

### 2.3 The FDC design in the doc was circular — corrected

Doc §3.9 and §6.12 route the payment through FDC: the customer pays FXRP on
Coston2, then FDC verifies that payment. This does not hold up. An ERC-20
transfer on Coston2 is *already in the state of the contract being asked to
verify it* — the contract can read `balanceOf` or receive the transfer directly.
Asking an attestation protocol to prove a fact the verifier already knows adds
latency, cost and a trusted round-trip while proving nothing.

FDC exists to bring in data the chain **cannot** see. So Fluxa runs two rails:

**Rail A — on-Flare (FXRP / USDT0).** Customer pays an ERC-20 on Coston2. The
contract observes the transfer itself. No FDC. Fast and dependency-free; this is
the reliable demo path.

**Rail B — cross-chain (native XRP on XRPL testnet).** Customer pays real XRP on
the XRP Ledger, tagging the invoice. FDC attests that payment, and the Merkle
proof is verified on Coston2 before the invoice moves to `PAID`.

Rail B is where FDC does genuine work, and it is a stronger claim for the
*Interoperable Asset Products* track than the original design: a payment
originating on a non-EVM chain settles a Flare invoice. Rail A keeps the demo
safe if the verifier API key or DA Layer is unavailable.

This is a deliberate, documented departure from the project doc. Everything else
in §3 and §6 stands.

## 3. Confirmed addresses

Resolved through `FlareContractRegistry.getContractAddressByName()`, all
confirmed to contain deployed code.

| Contract | Address |
| --- | --- |
| FlareContractRegistry | `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` |
| FtsoV2 | `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` |
| FeeCalculator | `0x88A9315f96c9b5518BBeC58dC6a914e13fAb13e2` |
| FdcHub | `0x48aC463d7975828989331F4De43341627b9c5f1D` |
| FdcVerification | `0x906507E0B64bcD494Db73bd0459d1C667e14B933` |
| FdcRequestFeeConfigurations | `0x191a1282Ac700edE65c5B0AaF313BAcC3eA7fC7e` |
| Relay | `0xa10B672D1c62e5457b17af63d4302add6A99d7dE` |
| FlareSystemsManager | `0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52` |
| AssetManagerController | `0x1C772F700308aF4c13897cc7b9c41EFfB82c50C0` |
| WNat | `0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273` |
| AssetManager (FXRP) | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` |
| FXRP token | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| USDT0 token | `0xC1A5B41512496B80903D1f32d6dEa3a73212E71F` |

The registry address is identical across all Flare networks and is the only
address Solidity should hardcode. Contracts resolve the rest at runtime so they
survive protocol upgrades.

**Token identification note.** Coston2 hosts several plausible-looking USDT0
decoys (`testUSDT0` at `0x21709E63…`, `0x6F6238Dc…`, `lodUSDT0`, and a `USDT
Token` at `0xAC6e1c5f…`). The correct token is the one above: symbol `USD₮0`,
name `USDT0 test`, ~6,292 holders. Verified by symbol and holder count, not by
name similarity.

## 4. FTSOv2 integration

Feed IDs are 21 bytes: one category byte (`0x01` = crypto) followed by the ASCII
feed name, right-padded.

| Feed | ID |
| --- | --- |
| XRP/USD | `0x015852502f55534400000000000000000000000000` |
| USDT/USD | `0x01555344542f555344000000000000000000000000` |
| USDC/USD | `0x01555344432f555344000000000000000000000000` |
| FLR/USD | `0x01464c522f55534400000000000000000000000000` |

Encoding is off-by-one-prone; `config/flare.ts` derives each ID with
`encodeFeedId()` and the check script asserts the derived value equals the
literal, so a mistyped constant cannot ship.

Reads use `TestFtsoV2Interface` (all `view`, free) during development, and
`FtsoV2Interface` (`payable`) in production. Both come from
`ContractRegistry`.

**USDT/USD exists on Coston2**, which matters more than it first appears: the
FXRP → USDT0 conversion in doc §6.18 is computable from two FTSO feeds entirely
on-chain, with no DEX and no liquidity pool. Cross-asset settlement is priced by
Flare's own oracle.

Worked example at validation-time prices, for a $500 invoice:

```
pay     497572345 FXRP base units  (497.572345 FXRP)
settle  500525552 USDT0 base units (500.525552 USDT0)
```

## 5. FAssets / FXRP

Decoded from `AssetManager.getSettings()`. Note that `lotSizeAMG()` reverts on
this deployment — the AssetManager is a diamond proxy and that selector is not
exposed; `getSettings()` is the working path.

| Parameter | Value |
| --- | --- |
| fAsset | `0x0b6A3645…dc7` (matches FXRP token) |
| assetMintingDecimals | 6 |
| Lot size | 10 XRP |
| Max redeemed tickets | 20 |
| Redemption default factor | 10500 BIPS (5% premium) |
| Chain source id | `testXRP` |

This resolves the open question from the FXRP parameters page, whose tabs lost
their network labels — the Coston2 row is lot size **10 XRP**, read from chain
rather than inferred from the table.

Fluxa treats FXRP as a standard 6-decimal ERC-20 and does **not** mint or redeem
it. Minting requires collateral reservation with an agent and an XRPL payment —
out of scope for the MVP, and unnecessary since the faucet supplies FXRP.

## 6. FDC integration (Rail B)

| Item | Value |
| --- | --- |
| Protocol ID | 200 |
| Voting epoch | 90 seconds |
| First voting round start | 1658429488 |
| Attestation type | `Payment` (`XRPPayment`, type `0x08`, is a candidate upgrade) |
| Source ID | `testXRP` |
| Verifier | `https://fdc-verifiers-testnet.flare.network/` |
| DA Layer | `https://ctn2-data-availability.flare.network/` |

Round derivation:

```
roundId = (blockTimestamp - firstVotingRoundStartTs) / votingEpochDurationSeconds
```

`fdcProtocolId()` returns 200, but the docs instruct reading it at runtime rather
than hardcoding, and Fluxa follows that.

The five-stage flow is: prepare request at the verifier → submit to `FdcHub`
with fee → wait for finalization on `Relay` → fetch the Merkle proof from the DA
Layer → verify on-chain via `FdcVerification`.

`Payment` responses carry `standardPaymentReference`, a 32-byte field that maps
directly onto an invoice ID — this is how an XRPL payment is bound to a specific
Fluxa invoice. The newer `XRPPayment` type additionally exposes `destinationTag`
and `firstMemoData`, which would be cleaner still; both routes return HTTP 401
(not 404) on the testnet verifier, confirming both exist. `verifyPayment` is
confirmed on the `IFdcVerification` interface. `verifyXRPPayment` is **not yet
confirmed** on the deployed contract, so the build targets `Payment` and treats
`XRPPayment` as an upgrade pending on-chain confirmation.

**Open dependency:** the verifier requires `VERIFIER_API_KEY_TESTNET`. Without
it, requests return HTTP 401 (a zero-UUID key returns 400). Rail B cannot be
demonstrated until this key is obtained. Rail A has no such dependency, which is
precisely why the demo leads with it.

## 7. Tooling notes

- Solidity **0.8.28**, EVM version **cancun** — the Flare periphery libraries do
  not compile under older EVM versions.
- `@flarenetwork/flare-periphery-contracts@0.1.52`; the network is the first path
  segment in every import (`coston2/...`).
- Hardhat **2.29** with toolbox 6. Hardhat 3 exists but changes the config format,
  and Flare's own starter and documentation target Hardhat 2.
- Addresses must carry correct EIP-55 checksums or ethers v6 rejects them at
  runtime. Do not retype addresses by hand; copy them or run them through
  `getAddress()`.
- Python's HTTPS stack is misconfigured in this environment
  (`CERTIFICATE_VERIFY_FAILED`). Use `curl` for network calls; Python is fine for
  offline work.

## 8. Verdict

The architecture in FLUXA.docx is sound and buildable on Coston2 as specified,
with one correction: FDC must attest a genuinely external payment (Rail B) rather
than a same-chain transfer. Cross-asset settlement is better supported than the
doc assumed, because USDT/USD is available on FTSOv2 and makes the conversion
computable on-chain.

Cleared to build.
