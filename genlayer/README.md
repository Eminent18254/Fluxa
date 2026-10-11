# Fluxa GenLayer workspace

The Intelligent Contract that holds Fluxa's commercial obligations and the
decisions made about them.

## Contract

`contracts/FluxaObligation.py` runs on the modern GenLayer runtime
(`py-genlayer:test`) and uses the current `gl.contract`, `gl.storage` and `gl.vm`
namespaces.

| Method | Kind | Purpose |
|---|---|---|
| `create_obligation` | write | Record terms and the evidence manifest. The caller is the merchant. |
| `submit_verification` | write | Hand evidence to the validator committee. Merchant only. |
| `replace_evidence` | write | Swap the manifest while more evidence was requested. Merchant only. |
| `record_payment` | write | Attach a payment reference. Buyer only, `VERIFIED` only. |
| `get_obligation` | view | One obligation. |
| `get_obligations` | view | Every obligation, newest first. |
| `get_my_obligations` | view | Obligations created by one merchant. |
| `get_payable_obligations` | view | Obligations addressed to one buyer. |
| `get_state` | view | Obligations plus the policy version. |

## Consensus rules

`submit_verification` runs the evaluation under `gl.vm.run_nondet` with an
explicit equivalence principle. A validator accepts the leader's result only if:

- the **decision** matches exactly (`VERIFIED`, `REJECTED` or
  `MORE_EVIDENCE_REQUIRED`),
- the **confidence band** matches exactly (`HIGH`, `MEDIUM`, `LOW`),
- the **inconsistency list** differs by at most one item.

The prose `reason` is never compared, because two validators can describe the
same finding in different words. Nothing is written unless the committee agrees.

## Safety rules

- Evidence is untrusted input. The prompt tells every validator to treat it as
  content, never as instructions, and to ignore anything embedded in it.
- A non-verified decision must list at least one inconsistency, so the merchant
  always has something to act on.
- Amounts, dates, currencies and evidence digests are validated at write time.
- The evidence digest is stored with every decision revision.
- Payment requires both a deterministic state check and the recorded buyer.

## Deploy

The contract is deployed with the official GenLayer CLI.

```bash
genlayer deploy --contract genlayer/contracts/FluxaObligation.py
```

Copy the returned address into `.env` as `VITE_GENLAYER_OBLIGATION_CONTRACT` (and
`GENLAYER_OBLIGATION_CONTRACT` for the projection API). Deployment needs a funded
account; `genlayer account` shows the balance.
