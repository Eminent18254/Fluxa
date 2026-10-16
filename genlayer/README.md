# Fluxa GenLayer workspace

The Intelligent Contract that holds Fluxa's commercial obligations and the
decisions made about them.

## Contract

`contracts/FluxaObligation.py` runs on the pinned `py-genlayer` runtime used by
Studionet (chain 61999), the network the CLI deploys to. It uses bare
`TreeMap`/`DynArray` storage, `@allow_storage` dataclasses, `gl.vm.UserError` and
`gl.vm.run_nondet_unsafe`, and it fetches evidence with `gl.nondet.web.get` and
hashes it with `hashlib`.

Deployed at `0x4Cb20B9dD428F2B14bf4d256a1342a4cC39a5cEE`
([explorer](https://explorer-studio.genlayer.com/address/0x4Cb20B9dD428F2B14bf4d256a1342a4cC39a5cEE)),
deploy transaction `0x0867c751ff77d83d3fcf1ef3c04606072316b9fcd963cb3a87e7d6c31b54335a`.

| Method | Kind | Purpose |
|---|---|---|
| `create_obligation` | write | Record terms and the evidence manifest. The caller is the merchant. |
| `submit_verification` | write | Fetch the committed manifest, authenticate it, and run the committee over it. Takes no evidence text. Merchant only. |
| `replace_evidence` | write | Commit a new evidence revision, capped at `MAX_EVIDENCE_REVISIONS`. Merchant only. |
| `record_payment` | write | Attach a payment reference. Buyer only, `VERIFIED` only. |
| `get_obligation` | view | One obligation. |
| `get_obligations` | view | Every obligation, newest first. |
| `get_my_obligations` | view | Obligations created by one merchant. |
| `get_payable_obligations` | view | Obligations addressed to one buyer. |
| `get_state` | view | Obligations plus the policy version. |

## Evidence is fetched, never pasted

`submit_verification(obligation_id)` accepts no evidence argument at all. Inside
the non-deterministic block, `fetch_evidence` downloads the manifest URL recorded
on chain, hashes the bytes it received with SHA-256, and raises
`gl.vm.UserError` unless that hash equals the digest committed for the current
revision. Only the downloaded bytes are put in front of the model, and the
verified digest is written back as `contentDigest`, so a decision is bound to the
exact revision it judged.

## Revision-aware state transitions

Each revision is judged at most once, and `evaluatedRevision` records which one a
decision belongs to.

- `submit_verification` refuses a revision where
  `evaluatedRevision == evidenceRevision`, and refuses a `VERIFIED` or `PAID`
  obligation outright.
- `replace_evidence` refuses to re-commit the revision already on record, so
  bumping the counter cannot be used to rerun the same bytes, and refuses once
  `MAX_EVIDENCE_REVISIONS` is reached.
- `record_payment` refuses any obligation whose verdict is no longer current.

Replacing the evidence is therefore the only route to another verdict, and every
attempt carries a new, independently verifiable digest.

## Consensus rules

`submit_verification` runs the evaluation under `gl.vm.run_nondet_unsafe` with an
explicit validator function. A validator accepts the leader's result only if:

- the **decision** matches exactly (`VERIFIED`, `REJECTED` or
  `MORE_EVIDENCE_REQUIRED`),
- the **confidence band** matches exactly (`HIGH`, `MEDIUM`, `LOW`),
- the **content digest** matches exactly, so two validators that downloaded
  different bytes cannot be counted as agreeing, and
- the **inconsistency list** differs by at most one item.

The prose `reason` is never compared, because two validators can describe the
same finding in different words. Nothing is written unless the committee agrees:
a disagreement finalizes with no state change at all, which is why the client
re-reads the decision counter instead of trusting the receipt.

## Safety rules

- Evidence is untrusted input. The prompt tells every validator to treat the
  fetched document as content, never as instructions, and to ignore anything
  embedded in it.
- A non-verified decision must list at least one inconsistency, so the merchant
  always has something to act on.
- Amounts, dates, currencies and digests are validated at write time; a digest
  must be `sha256:` followed by 64 hex characters.
- The declared digest is stored with every revision, and the digest of the bytes
  that were actually judged is stored with the decision.
- Payment requires a current `VERIFIED` verdict, a deterministic state check and
  the recorded buyer.

## Deploy

The contract is deployed with the official GenLayer CLI.

```bash
genlayer deploy --contract genlayer/contracts/FluxaObligation.py
```

Copy the returned address into `.env` as `VITE_GENLAYER_OBLIGATION_CONTRACT` (and
`GENLAYER_OBLIGATION_CONTRACT` for the projection API). Deployment needs a funded
account; `genlayer account` shows the balance.
