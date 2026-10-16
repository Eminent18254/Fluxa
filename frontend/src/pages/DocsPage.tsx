import { ArrowUpRight, CircleDollarSign, ExternalLink, Eye, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { Wordmark } from '@/components/landing/Brand'
import { GENLAYER } from '@/config/genlayer'
import { paths } from '@/paths'

const steps = [
  ['01', 'Record the terms', 'The merchant writes the reference, amount, currency, buyer wallet and due date. These are the commercial terms and they are stored on chain.'],
  ['02', 'Attach the evidence', 'An HTTPS manifest URL and the SHA-256 digest of the file are recorded on chain with the terms, so the exact bytes under review are fixed before anyone reads them.'],
  ['03', 'Validators decide', 'The committee fetches that URL itself and refuses to proceed unless the bytes hash to the recorded digest, then rules and must agree on a bounded decision.'],
  ['04', 'Payment unlocks', 'Only a VERIFIED obligation can take a payment reference, and only from the buyer recorded on it.'],
]

const lifecycle = ['SUBMITTED', 'VERIFIED', 'REJECTED', 'MORE_EVIDENCE_REQUIRED', 'PAID']

export function DocsPage() {
  return (
    <div className="app-shell min-h-dvh text-night">
      <header className="px-4 pt-4 sm:px-8 sm:pt-6">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link to={paths.landing}>
            <Wordmark tone="dark" markClassName="size-9" textClassName="text-xl" />
          </Link>
          <Link
            to={paths.invoices}
            className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-white/75 px-4 py-2 text-sm font-semibold text-brand-700 shadow-sm"
          >
            Open app
            <ArrowUpRight className="size-4" />
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 pb-16 pt-8 sm:px-8 sm:pt-12">
        <section className="grain-overlay relative overflow-hidden rounded-[2rem] bg-[#4f89f2] px-6 py-8 text-white shadow-[0_28px_80px_rgba(31,91,237,.20)] sm:px-10 sm:py-11">
          <div className="absolute -right-20 -top-24 size-72 rounded-full border-[3.5rem] border-white/10" />
          <div className="relative max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[.18em] text-white/65">Fluxa documentation</p>
            <h1 className="mt-4 font-display text-4xl font-medium leading-tight sm:text-5xl">
              Evidence in. Explainable decision out.
            </h1>
            <p className="mt-5 text-base leading-relaxed text-white/75">
              Fluxa records a commercial obligation on GenLayer, has a validator committee read the evidence against the
              recorded terms, and only unlocks payment on a decision it can explain. Everything runs on{' '}
              {GENLAYER.chainName}.
            </p>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          {steps.map(([number, title, body]) => (
            <div key={number} className="app-panel rounded-2xl p-5">
              <span className="font-display text-sm font-semibold text-brand-600">{number}</span>
              <h2 className="mt-3 font-display text-lg font-semibold text-night">{title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-night/55">{body}</p>
            </div>
          ))}
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <Guide
            title="For merchants"
            items={[
              'Connect the wallet that will own the obligation.',
              'Record the terms, then attach the evidence manifest URL and its SHA-256 digest.',
              'Run verification. The committee downloads the manifest and checks it against the digest on record before reading anything.',
              'If it asks for more evidence, commit a new evidence revision and run it again. Revisions are capped, so a rejected result cannot be rerun unchanged.',
              'Share the obligation link with the buyer and track the state from the workspace.',
            ]}
          />
          <Guide
            title="For buyers"
            items={[
              'Open the link from the merchant. No Fluxa account is required to read it.',
              'Check the amount, the parties, the due date, and the evidence manifest.',
              'Read the committee decision, its reasoning, and any listed inconsistencies.',
              'Connect the wallet recorded as the buyer and switch to the GenLayer network.',
              'Record the payment reference once the obligation reads VERIFIED.',
            ]}
          />
        </section>

        <section className="app-panel rounded-3xl p-6 sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[.14em] text-brand-600">Lifecycle</p>
          <h2 className="mt-2 font-display text-2xl font-semibold text-night">Five states, all of them on chain.</h2>
          <div className="mt-6 flex flex-wrap gap-2">
            {lifecycle.map((state) => (
              <span key={state} className="rounded-full bg-brand-50 px-3 py-1.5 font-mono text-xs font-semibold text-brand-700 ring-1 ring-inset ring-brand-100">
                {state}
              </span>
            ))}
          </div>
          <p className="mt-5 text-sm leading-relaxed text-night/55">
            A decision is append-only. Each review stores the decision, a confidence band, a written reason, the list of
            inconsistencies, and the revision of the evidence it was made against, so a changed file can never pass as the
            one that was judged.
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <DocCard
            icon={<ShieldCheck className="size-5" />}
            title="Bounded decisions"
            body="Validators must agree on the decision and the confidence band. Only the human-readable reason is free text."
          />
          <DocCard
            icon={<Eye className="size-5" />}
            title="Untrusted evidence"
            body="The prompt tells every validator to treat the evidence as content, never as instructions, and to ignore anything embedded in it."
          />
          <DocCard
            icon={<CircleDollarSign className="size-5" />}
            title="Deterministic payment"
            body="The contract checks the decision state and the recorded buyer address before a payment reference can be written."
          />
        </section>

        <section className="app-panel-soft rounded-3xl p-6 sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[.14em] text-brand-600">Why GenLayer</p>
          <h2 className="mt-2 font-display text-2xl font-semibold text-night">The judgment is the product.</h2>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-night/55">
            Whether a delivery note actually matches an invoice is not a question a deterministic contract can answer, and
            it is exactly the question a payment decision turns on. GenLayer runs that evaluation inside the contract and
            settles it by committee consensus, so the answer is not one model having a good day and not a merchant
            marking their own homework.
          </p>
          <div className="mt-6 flex flex-wrap gap-4">
            <a
              href="https://docs.genlayer.com"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700"
            >
              GenLayer documentation
              <ExternalLink className="size-4" />
            </a>
            <a
              href={GENLAYER.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700"
            >
              Block explorer
              <ExternalLink className="size-4" />
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-brand-100/70 px-4 py-6 text-center text-xs text-night/45">
        Fluxa · Evidence-backed commercial obligations on GenLayer · testnet only
      </footer>
    </div>
  )
}

function DocCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="app-panel rounded-2xl p-5">
      <span className="grid size-10 place-items-center rounded-xl bg-brand-600 text-white shadow-lg shadow-brand-600/15">{icon}</span>
      <h3 className="mt-5 font-display font-semibold text-night">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-night/52">{body}</p>
    </div>
  )
}

function Guide({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="app-panel rounded-3xl p-6 sm:p-8">
      <h2 className="font-display text-2xl font-semibold text-night">{title}</h2>
      <ol className="mt-6 space-y-4">
        {items.map((item, index) => (
          <li key={item} className="flex gap-3 text-sm leading-relaxed text-night/58">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-600 text-[.65rem] font-bold text-white">
              {index + 1}
            </span>
            {item}
          </li>
        ))}
      </ol>
    </div>
  )
}
