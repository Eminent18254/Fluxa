# Sprint 3 — Flare Integration (spec §7.4)

All four subsections of §7.4, with what was proved, how, and what is still blocked.

Verified against Coston2 (chain 114) on 2026-08-11/12. Test totals: **212 passing**,
of which 24 run against forked live Coston2 state.

---

## Two places the spec was wrong

Both were found by verifying before building, and both changed the design.

**1. The FDC design in the spec was circular** (found in Phase 0, recorded in
`PHASE-0-FLARE-VALIDATION.md` §2.3). The spec had FDC attesting the customer's
payment in all cases. But an ERC-20 transfer on Coston2 is *already in the state of
the contract being asked to verify it* — there is nothing to attest. Fluxa therefore
has two rails:

| | Rail A | Rail B |
|---|---|---|
| Customer pays | FXRP (or USDT0) on Coston2 | native XRP on XRPL testnet |
| How Fluxa knows | the contract observes the transfer | FDC attestation, Merkle-verified on Coston2 |
| Contract | `FluxaInvoice.payInvoice` | `FluxaFdcPaymentRail.payInvoiceFromXrpl` |

FDC is load-bearing for Rail B and genuinely unnecessary for Rail A.

**2. `FLARE_TIMING.firstVotingRoundStartTs` was 512 seconds wrong.** Config recorded
`1658429488`; the live `FlareSystemsManager` reports `1658430000`. That is 5.7 voting
rounds, and the failure mode is silent: the arithmetic still succeeds, it just names a
round the DA layer has no proof for, which is indistinguishable from an unconfirmed
attestation. Sprint 3 now reads the grid from chain (`config/fdcTiming.ts`) and reports
the drift rather than trusting the constant. **The Sprint 1 constant is still wrong and
should be corrected — left alone here because Sprint 1 is out of scope.**

---

## §7.4.1 — Coston2 integration

`scripts/deploy.ts` runs the same code path locally and against Coston2, deploying
`FluxaInvoice`, `FluxaSettlement`, `FluxaPriceOracle` and `FluxaFdcPaymentRail`, then
reading every piece of state back. 30 post-deploy assertions, all passing locally.

The only hardcoded address in Solidity is the Flare Contract Registry
(`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`, identical on every Flare network).
Everything else — FtsoV2, FeeCalculator, FdcVerification — is resolved at runtime, so
the deployment survives Flare's protocol upgrades.

**Blocked:** the live Coston2 deploy needs `PRIVATE_KEY` in the repo-root `.env`, which
does not exist in this repository. `hardhat.config.ts` gives `coston2` an empty
`accounts: []` without it. Local dry-run passes; the live run is one command once the
key is set:

```
npx hardhat run scripts/deploy.ts --network coston2
```

## §7.4.2 — FTSOv2

`FluxaPriceOracle` reads `getFeedById(bytes21)` through the registry. 8 fork tests
against live FTSOv2.

The trap here is decimals: **they differ per feed** — XRP/USD is 6dp, FLR/USD is 8dp.
A hardcoded exponent works until it silently misprices by 100×, so the oracle carries
the feed's own `decimals` through every calculation.

Feed fees are zero on Coston2 today. That is asserted rather than assumed, because the
free `view` read path only works while it holds; `getPriceUsdPaying` is the answer if
it stops.

## §7.4.3 — FAssets / FXRP

8 fork tests, `test/FluxaFxrp.coston2.test.ts`. Every assertion here passes trivially
against a mock, because a mock is 6-decimal and fee-free by construction. FXRP is a
diamond-proxied FAsset, so it was worth checking:

- **FXRP moves at face value.** All four FAssets transfer-fee selectors revert on this
  deployment, and an actual fork transfer confirms it — so escrow's exact-amount check
  holds and Rail A works for FAssets.
- **6 decimals, not 18**, read off the live token.
- Provenance traced Registry → `AssetManagerController` → AssetManager
  `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` → `fAsset()`, with
  `assetMintingDecimals() == 6` and `lotSize() == 10 XRP`.
- A $500 invoice paid with real FXRP from a real wallet, priced off live FTSOv2
  (495.483667 FXRP @ $1.009115), settled to the merchant in USDT0 (500.474951 @
  $0.999051). **Payment asset ≠ settlement asset, on real assets** — the core product
  claim.

One incidental finding: the impersonated whale had moved 100k FXRP since capture
(1,080,122 → 980,031), so `findFundedHolder`'s candidate-degradation logic earned its
place.

## §7.4.4 — FDC

The spec says this is "not simply to mention FDC in the documentation", so:

**`contracts/FluxaFdcPaymentRail.sol`** — verifies an `IPayment` proof of an XRPL
payment, then fronts its own FXRP through the ordinary `payInvoice`. **Zero Sprint 2
diff.** The alternative was a privileged mark-paid hook, which would mean changing
`releaseEscrow`, the escrow accounting and the settlement path — `releaseEscrow` reverts
`ZeroAmount()` on empty escrow, so an invoice marked PAID without funds would be
permanently unsettleable.

The cost of fronting, stated plainly: the invoice records `rail = FLARE_ERC20` and
`payer = address(this)`. True provenance lives in `recordOf(invoiceId)` and the
`XrplPaymentAccepted` event. That indirection is the price of not modifying Sprint 2,
and it is the right trade — a wrong edit to escrow accounting loses money, a join does
not.

Why `IPayment` + `testXRP` rather than `IXRPPayment`: `IXRPPayment` has no
`standardPaymentReference` field (it carries `firstMemoData`/`destinationTag`), and the
reference is how a proof is tied to an invoice. Decided from the interfaces, not
preference.

Why drops compare directly to FXRP base units: both are 1e-6 scale. 1 XRP drop == 1
FXRP base unit, asserted on-chain via `ASSET_MINTING_DECIMALS`.

**Tests — two suites, neither sufficient alone:**

- `FluxaFdcPaymentRail.test.ts` — **40 passing**, offline against `MockFdcVerification`.
  Every rejection path, including the two checks most often omitted (attestation type
  and source id — `verifyPayment` proves Merkle membership, *not* that the response is
  the type or chain you asked about), the `int256 receivedAmount` cast trap, and replay
  across two invoices bound to the same merchant. One test asserts escrow and settlement
  are untouched, which is the evidence Sprint 2 did not need to change.
- `FluxaFdcPaymentRail.coston2.test.ts` — **8 passing** against the real
  `FdcVerification` at `0x906507E0B64bcD494Db73bd0459d1C667e14B933`. The load-bearing
  one hands the live verifier the same fabricated proof the offline suite pays an
  invoice with, and asserts the rail refuses it with `ProofRejected` while escrow and
  float stay untouched. **That is what makes the mock trustworthy rather than
  circular.** Also confirms live `fdcProtocolId() == 200`, a live `Relay` behind the
  verifier, and that the `Payment` type is genuinely served for XRPL.

**`scripts/fdcRequestProof.ts`** — the six-stage off-chain round trip: prepare → fee →
request → wait a voting round → collect the proof → redeem against the rail. Each stage
fails with its own diagnosis and remedy, because a 401 from the verifier, an unfunded
deployer and an unfinalised round all surface as an absent proof and have nothing to do
with each other.

**Blocked, and this is the honest boundary:** stage 1 needs
`VERIFIER_API_KEY_TESTNET`, which Flare issues on request and is not in this repo. So
**a successful Rail B payment has never been executed end-to-end.** What *has* run
against live Coston2 is everything that does not need the key — the default preflight
mode resolves every FDC contract through the registry, prices a real request, derives
the round grid from chain, and inspects the XRPL transaction:

```
npx hardhat run scripts/fdcRequestProof.ts --network coston2
```

```
  FdcHub                       0x48aC463d7975828989331F4De43341627b9c5f1D
  FdcVerification              0x906507E0B64bcD494Db73bd0459d1C667e14B933
  FdcRequestFeeConfigurations  0x191a1282Ac700edE65c5B0AaF313BAcC3eA7fC7e
  FDC protocol id              200
  voting round                 1423243 (90s epochs from 1658430000)
```

To summarise the boundary precisely: Fluxa is wired to the real FDC and provably rejects
invalid proofs. It is not proved that a *valid* proof is accepted, because no valid proof
can be produced without the key. Once the key exists, no code should need to change —
set it in `.env` and run with `FDC_FULL=1`.

The XRPL payment must carry the invoice's `paymentRef` as its first memo's MemoData
(hex, no `0x`). That is where FDC reads `standardPaymentReference`, and the rail rejects
any proof whose reference does not match the invoice.

---

## Files

New in Sprint 3:

```
contracts/FluxaFdcPaymentRail.sol          Rail B
contracts/mocks/MockFdcVerification.sol
config/fdcTiming.ts                        chain-resolved voting-round grid
scripts/fdcRequestProof.ts                 off-chain FDC round trip
test/FluxaFdcPaymentRail.test.ts           40 offline
test/FluxaFdcPaymentRail.coston2.test.ts    8 live FDC
test/FluxaFxrp.coston2.test.ts              8 live FXRP/USDT0
test/FluxaPriceOracle.coston2.test.ts       8 live FTSOv2
test/forkHelpers.ts
```

Sprint 1 and Sprint 2 sources are unmodified. `scripts/deploy.ts` gained the rail
deployment and its assertions additively; no existing deploy step changed.

One harness note worth keeping: `forkCoston2()` mines a single local block before
returning. EDR treats the fork block as *historical* and needs a hardfork-activation
history to execute against it, which it does not have for chain 114 — so any read taken
before the first transaction fails with `No known hardfork for execution on historical
block N`. Easy to miss, because any deploy hides it by advancing the block itself.

## Open items

| Item | Blocked on | Owner |
|---|---|---|
| Live Coston2 deploy | `PRIVATE_KEY` in `.env` | user |
| Rail B end-to-end | `VERIFIER_API_KEY_TESTNET` from Flare | user |
| `FLARE_TIMING.firstVotingRoundStartTs` → `1658430000` | Sprint 1 scope | user's call |
