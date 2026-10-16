# Fluxa

![React](https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-4-06B6D4?logo=tailwindcss&logoColor=white)
![GenLayer](https://img.shields.io/badge/GenLayer-Intelligent%20Contract-5B4FE9)
![Studionet](https://img.shields.io/badge/Studionet-chain%2061999-1F8A70)
![SQLite](https://img.shields.io/badge/SQLite-local%20projection-003B57?logo=sqlite&logoColor=white)

**An invoice is paid when the evidence proves it.** Fluxa is evidence-backed commercial obligations on **GenLayer Intelligent Contracts**. A merchant records an obligation - amount, currency, due date, buyer - together with an evidence manifest and the SHA-256 digest of the file it serves. A GenLayer validator committee then fetches that manifest itself, refuses to run unless the bytes hash to the recorded digest, and judges what it downloaded against those published terms. Only a recognized decision unlocks the payment path, and only the recorded buyer can record that payment.

> Fluxa is the answer to one specific problem: proof. On a normal invoicing tool the merchant asserts the invoice is real and the buyer has to take their word for it, or a human team has to read the paperwork. Fluxa replaces that trust with a validator committee. Independent validators evaluate the evidence against the terms stored in the contract and must agree on the result - a decision, a confidence band and the specific inconsistencies - before it is accepted. The committee never pays anyone and never moves funds; it decides whether the evidence supports the obligation, and the terms of that decision are public.

The key idea is simple. **The commercial terms are stored on chain before the evidence is judged, and the verdict is produced by consensus rather than by the party who benefits from it.** A merchant knows exactly what has to be proven, and a reader can see exactly which part of the evidence failed to line up.

Fluxa runs on **GenLayer Studionet** with test funds only.

## Deployed Contract

|                      |                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Contract address** | `0x4Cb20B9dD428F2B14bf4d256a1342a4cC39a5cEE`                                                               |
| **Explorer link**    | https://explorer-studio.genlayer.com/address/0x4Cb20B9dD428F2B14bf4d256a1342a4cC39a5cEE                    |
| Network              | GenLayer Studionet, chain 61999                                                                            |
| RPC                  | `https://studio.genlayer.com/api`                                                                          |
| Deploy transaction   | https://explorer-studio.genlayer.com/tx/0x0867c751ff77d83d3fcf1ef3c04606072316b9fcd963cb3a87e7d6c31b54335a |
| Source               | `genlayer/contracts/FluxaObligation.py`                                                                    |
| Runtime              | `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`                                         |
| Redeploy             | `npm run deploy:contract`                                                                                  |

> **Direct link:** https://explorer-studio.genlayer.com/address/0x4Cb20B9dD428F2B14bf4d256a1342a4cC39a5cEE

The contract was deployed with the GenLayer CLI, and the address is verified by reading the live state:

```bash
genlayer call 0x4Cb20B9dD428F2B14bf4d256a1342a4cC39a5cEE get_state
```

## Live Deployment

|              |                                                                |
| ------------ | -------------------------------------------------------------- |
| App contract | `0x4Cb20B9dD428F2B14bf4d256a1342a4cC39a5cEE` (Studionet 61999) |

The deployment is the static bundle produced by `npm run build`. `frontend/vercel.json` supplies the SPA rewrites, so a hard refresh on any route resolves to the bundle. The only runtime configuration the bundle needs is the contract address, and that address is compiled in, so a host with no environment variables still boots against the live deployment.

## How Fluxa Works

1. **Record the obligation.** The merchant calls `create_obligation` with a reference, the buyer's wallet, a currency, an amount in minor units, a due date, and an evidence manifest (an HTTPS URL plus its `sha256:` digest). The caller becomes the merchant. The reference is unique and the buyer must be a real address.
2. **Ask the committee to verify.** The merchant calls `submit_verification` with the obligation id and nothing else - there is no evidence argument to phrase. Every participant downloads the manifest URL, hashes the bytes with SHA-256 and abandons the call unless that hash equals the digest committed for this revision. Only then do they run the same prompt against an LLM, and consensus compares the bounded fields plus the digest of the bytes each of them read.
3. **Read the decision.** The committee returns one of `VERIFIED`, `REJECTED` or `MORE_EVIDENCE_REQUIRED`, plus a confidence band (`HIGH`, `MEDIUM`, `LOW`) and a list of the specific inconsistencies. The decision, the band, the reason, the revision counters and the policy version are written on chain.
4. **Replace evidence if asked.** When the decision is `MORE_EVIDENCE_REQUIRED` - or `REJECTED`, if the manifest was simply the wrong file - the merchant can call `replace_evidence` to commit a new manifest and digest. That is the only route to another verdict: a revision is judged once, re-committing the revision already on record is refused, and the revisions are capped at three.
5. **Record the payment.** Once the obligation is `VERIFIED`, the recorded buyer calls `record_payment` with a payment reference. That flips the obligation to `PAID`.

Statuses are the contract's own bounded enum - `SUBMITTED`, `VERIFIED`, `REJECTED`, `MORE_EVIDENCE_REQUIRED`, `PAID` - and the UI shows them verbatim. A screen that said "open" when the contract says `MORE_EVIDENCE_REQUIRED` would be lying about the one thing the merchant has to act on.

## Evidence Anchoring and Revision Gates

Two properties make a verdict mean something, and both are enforced in the contract rather than in the interface.

**The committee never reads what the merchant typed.** `submit_verification` takes no evidence text at all. Inside the non-deterministic block each participant downloads the manifest URI recorded on chain, hashes what it received, and refuses to continue unless the hash equals the digest committed for this revision (`fetch_evidence`). Because that check runs inside the block, every validator authenticates independently, and the digest of the bytes that were actually read travels back with the decision and is stored as `contentDigest`. A manifest that has been edited since it was committed reverts the call instead of being judged, and consensus compares `contentDigest` as well as the decision, so validators that downloaded different content cannot be counted as agreeing.

**A verdict belongs to one evidence revision.** Each decision stores the revision it judged (`evaluatedRevision`) and the digest of those bytes. `submit_verification` refuses to judge a revision twice and refuses to touch a `VERIFIED` or `PAID` obligation; `replace_evidence` refuses to re-commit the revision already on record, so bumping the counter cannot be used to rerun the same bytes. A new verdict therefore requires genuinely new evidence, `MAX_EVIDENCE_REVISIONS` bounds how many times that can happen, and a rejected obligation cannot be rerun with reworded text until the committee changes its mind. The interface reads the same state through `reviewState`, so it cannot offer a button whose only possible outcome is a revert.

This is what was observed on Studionet against the deployed contract:

| Behaviour                                             | Transaction                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Committee fetched the manifest and returned `VERIFIED` (digest stored as `contentDigest`) | `0x72d753a20b3549b6d1fd6c26b8745bffa979167c15d5446d377018348e8c602b` |
| Manifest whose bytes do not match the committed digest is refused, not judged | `0xfe9abddeb9d04b9df8b3f4fa07e2960df77bf748faf4457797f5a7abd081e59c` |
| A revision that has already been judged cannot be run again | `0x5305bc90fed826eb5ff7dda42ba6ededd2e70839d90f721b8e0cd077bd31b82f` |
| Re-committing the revision already on record is refused | `0x620392489155554f763f0139bfb187847247b54fb5bb90b8dec268a7256b49b3` |
| A contradicting manifest returns `REJECTED`, and `record_payment` is refused | `0x5166d6949fc5fa543d5895756c66607db32072e296760c13f5115386507dac5c` |
| A new revision reopens the obligation for exactly one more review | `0x07e6f3a81b5c191f0a161da1a3cc5046956fb34e4210f921ccfd4fa74f833e6b` |
| A verified obligation takes the buyer payment and then closes to both reruns and replacements | `0x2e67c25753f7ee50843fc40dfe1cadbd8389d3dc249c0077bf67742b6328ec20` |

## The User Journey

| Path            | Screen                                                        |
| --------------- | ------------------------------------------------------------- |
| `/`             | Landing page                                                  |
| `/invoices`     | Obligations the connected wallet can see - created or payable |
| `/invoices/new` | Record an obligation and run verification                     |
| `/i/:id`        | Obligation detail, decision record and the payment path       |
| `/docs`         | How the verification model works                              |

A first-time visitor meets the product story at `/`. Connecting a wallet with no obligations yet shows an empty state rather than a broken list.

## Why GenLayer

The hard part of an evidence-backed obligation is not storage, it is judgment. A deterministic contract cannot read an invoice PDF and decide whether the amount, the parties and the dates line up; an oracle that answers with a single trusted key just moves the trust to that key. GenLayer is the only piece that makes the design work: a validator committee fetches the evidence itself, authenticates it against the digest committed on chain, and has to agree on bounded output before anything is written to state. The contract stores the terms, the digest of the bytes the committee actually read, the decision and its revision history - and nothing about the verdict depends on a server Fluxa operates.

## Architecture

```
genlayer/
  contracts/FluxaObligation.py   the Intelligent Contract (Python, pinned runtime)
frontend/
  src/config/genlayer.ts          the one chain and the deployed address
  src/lib/genlayer/client.ts      the only module that talks to GenLayer
  src/lib/obligations.ts          the domain model, mirrored from the contract
  src/pages/                      the screens
api/
  src/contract.ts                 server-side reads of the contract
  src/db.ts                       SQLite (node:sqlite) obligations + decisions
  src/sync.ts                     one-shot contract -> SQLite projection
  src/server.ts                   read-only HTTP API over the SQLite mirror
```

**The frontend is the product.** Every screen reads the contract directly through `genlayer-js`, so the app works with nothing running beside it. Reads need no wallet, so an obligation link opens for anyone.

**The API is a mirror, never a source of truth.** `api/` syncs the contract's public views into a local SQLite file with `node:sqlite` - no hosted database, no service keys, no third-party credentials - and serves read-only queries over it. The file is created on first run at `api/data/fluxa.sqlite`. If it is deleted, `npm run sync` rebuilds it from chain. The contract is always authoritative; the mirror exists so historical queries and counting do not have to re-walk chain state.

### Contract surface

| Method                    | Kind  | Purpose                                             |
| ------------------------- | ----- | --------------------------------------------------- |
| `create_obligation`       | write | Record the terms; caller becomes the merchant       |
| `submit_verification`     | write | Fetch the committed manifest and run the committee over it |
| `replace_evidence`        | write | Commit a new evidence revision (capped, one verdict each) |
| `record_payment`          | write | The recorded buyer marks a verified obligation paid |
| `get_state`               | view  | Obligations, policy version and count in one call   |
| `get_obligation`          | view  | One obligation by id                                |
| `get_obligations`         | view  | Every obligation, newest first                      |
| `get_my_obligations`      | view  | Obligations where an address is the merchant        |
| `get_payable_obligations` | view  | Obligations where an address is the buyer           |

## Non-Custodial by Design

Fluxa never creates, holds or asks for a private key in the browser. Writes are signed by an injected EIP-1193 wallet such as MetaMask, and the SDK routes signing calls straight to that provider. The wallet must be on GenLayer Studionet; if it is not, the app asks it to switch rather than failing silently. Payment recording is an on-chain attestation by the recorded buyer - the contract does not take custody of funds.

## Security

- **Bounded model output.** Only the decision enum, the confidence band and the inconsistency list move state. The validator function rejects anything that is not the expected shape, and a non-verified decision must list at least one inconsistency so the merchant has something to act on.
- **Consensus on meaning, not wording.** The validator compares the bounded fields and allows at most one item of drift in the inconsistency list. It never compares the prose reason.
- **Anchored evidence.** The committee judges only bytes it downloaded itself and proved against the digest committed on chain; the digest it verified is stored with the decision as `contentDigest`, so any reader can re-fetch the manifest and confirm what was judged.
- **No verdict shopping.** A revision is judged once, a `VERIFIED` obligation is final, and revisions are capped, so a rejected result cannot be re-rolled. The decision counter and the judged revision are both on chain.
- **Untrusted evidence.** The prompt labels the fetched document as hostile and forbids following instructions inside it.
- **Authorization in the contract.** Only the merchant can submit verification or replace evidence; only the recorded buyer can record payment; only a currently-verified obligation can be paid.
- **Validation with real limits.** Reference length, currency as a three-letter code, amount greater than zero, due date as a unix timestamp, HTTPS-only manifests, `sha256:`-prefixed digests and a hard obligation cap are enforced on chain. The frontend validates the same limits before a transaction is offered.
- **No secrets in the bundle.** Deployment keys live in `genlayer/.secrets/`, which is gitignored, and are never imported by frontend code.

## Additional Features

Beyond the core loop, Fluxa includes:

- A landing page that renders from fixed marketing copy, so the product story never depends on chain availability
- A live contract link in the landing header and footer, so the deployment is verifiable from the product itself
- A merchant view and a buyer view over the same on-chain obligations
- The full decision record on the detail screen: decision, confidence band, reason, inconsistency list, decision revision, the evidence revision it was made against, the digest of the judged bytes, and whether that verdict is still current
- A retry path that commits a new evidence revision - and shows which revision the decision on screen was made against, and whether it is still current
- Overdue highlighting and a due-date countdown derived from the on-chain due timestamp
- Form validation with field-level errors, plus success, error and empty states across the UI
- Real wallet connect and disconnect, with the connection restored on reload
- A local SQLite projection so historical queries never re-walk chain state

### Routes

| Path            | Screen                                              |
| --------------- | --------------------------------------------------- |
| `/`             | Landing page                                        |
| `/invoices`     | Obligations list - the workspace entry screen       |
| `/invoices/new` | Record an obligation and run verification           |
| `/i/:id`        | Obligation detail, decision record and payment path |
| `/docs`         | How verification and consensus work                 |

The landing page always owns `/`, so a first-time visitor meets the product story before the workspace.

`/i/:id` is deliberately outside the workspace shell: it is the link a merchant sends a buyer, and it has to load for someone with no wallet and no account.

## Getting Started

```bash
git clone <this repo>
cd Fluxa
npm run install:all
npm run dev            # frontend on http://localhost:5173

# optional: the SQLite projection API
npm run api            # read-only API on http://localhost:8787
npm run sync           # refresh the SQLite mirror from chain
```

Tests, typecheck and production build:

```bash
npm test               # unit tests over money, validation, due dates and review state
npm run typecheck      # frontend + api
npm run build          # static bundle in frontend/dist
```

Redeploying the contract (needs the GenLayer CLI and a funded Studionet account):

```bash
genlayer network set studionet
npm run deploy:contract
```

## Future Direction

- **A settlement rail.** The decision and the buyer's attestation are already on chain; a payout path completes `record_payment` into an actual transfer.
- **Appeals.** A merchant who disagrees with a verdict has no path today. A bonded appeal with a larger committee is the natural next step.
- **Reputation from verdict history.** Every obligation produces a scored, reasoned, on-chain record. That is a counterparty signal waiting to be surfaced.
- **Dispute windows.** Payment could be time-locked behind a challenge period before it is final.
- **Multi-document evidence.** Today one manifest URL and one digest per obligation; a manifest could reference several documents, each authenticated against its own digest.
- **Per-currency exponents.** The amount is stored in minor units with a two-decimal convention; currencies with other exponents deserve first-class support.

**Terms first. Evidence judged. Payment earned.**

## Built On

[GenLayer](https://genlayer.com) Intelligent Contracts on Studionet (chain 61999) - React 19 - Vite - Tailwind CSS v4 - `genlayer-js` 1.x - `lucide-react` - SQLite via `node:sqlite`.
