import { ArrowUpRight, BadgeDollarSign, CircleDollarSign, Orbit, ReceiptText, ShieldCheck, Sparkles, WalletCards } from 'lucide-react'
import { Button } from '@/components/Button'
import { useWalletModal } from '@/components/wallet/WalletModalProvider'

function Eyebrow({ children, dark = false }: { children: string; dark?: boolean }) {
  return <span className={`inline-flex rounded-full border px-3 py-1.5 text-[.68rem] font-semibold uppercase tracking-[.18em] ${dark ? 'border-white/20 bg-white/10 text-white/70' : 'border-brand-100 bg-white/65 text-brand-700 shadow-sm backdrop-blur'}`}>{children}</span>
}

function InvoiceCard() {
  return (
    <div className="relative mx-auto w-full max-w-md rounded-[2.2rem] bg-gradient-to-br from-brand-600 via-[#4f89f2] to-[#9ac3fb] p-1.5 shadow-[0_35px_100px_rgba(18,55,145,.22)] sm:p-2">
      <div className="rounded-[1.85rem] border border-white/90 bg-white/95 p-5 backdrop-blur-xl sm:p-7">
        <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-[.15em] text-night/35">Illustrative obligation</span><span className="rounded-full bg-brand-50 px-3 py-1 text-[.68rem] font-semibold text-brand-700 ring-1 ring-brand-100">Verified</span></div>
        <div className="mt-7 rounded-3xl border border-brand-100 bg-gradient-to-br from-[#edf4ff] via-white to-[#e4edff] px-4 py-6 text-center"><p className="text-xs font-semibold uppercase tracking-[.14em] text-brand-600/70">Obligation value · USD</p><p className="mt-2 font-display text-5xl font-semibold text-night">$500.00</p><p className="mt-2 text-sm text-night/48">Design and development services</p></div>
        <div className="mt-4 rounded-2xl border border-brand-100 bg-white p-4 shadow-[0_10px_30px_rgba(36,82,224,.06)]"><div className="flex items-center justify-between text-xs font-medium text-night/45"><span>Evidence submitted</span><span>Committee decision</span></div><div className="mt-3 flex items-center justify-between font-display font-semibold text-night"><span className="rounded-xl bg-brand-50 px-3 py-2 text-brand-700">Invoice + PO</span><span className="grid size-8 place-items-center rounded-full bg-brand-600 text-white shadow-md"><ArrowUpRight className="size-4" /></span><span className="rounded-xl bg-[#e8f1ff] px-3 py-2 text-brand-800">VERIFIED</span></div><p className="mt-3 text-center text-[.68rem] font-medium text-night/38">Only a VERIFIED decision unlocks payment.</p></div>
        <button className="mt-5 h-12 w-full rounded-full bg-gradient-to-b from-brand-500 to-brand-700 text-sm font-semibold text-white shadow-lg shadow-brand-600/20">Record payment</button>
      </div>
    </div>
  )
}

export function TechStrip() {
  return (
    <section className="bg-white px-6 pb-12 pt-3">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-8 gap-y-3 border-y border-brand-50 py-6 text-xs font-semibold uppercase tracking-[.14em] text-night/35">
        <span>Evidence manifests</span><span>Intelligent contracts</span><span>Validator consensus</span><span>GenLayer finality</span>
      </div>
    </section>
  )
}

export function Features() {
  return (
    <section id="product" className="scroll-mt-24 bg-white px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto max-w-3xl text-center"><Eyebrow>One obligation. One decision.</Eyebrow><h2 className="mt-6 font-display text-4xl font-medium leading-[1.04] tracking-[-.05em] text-night sm:text-6xl">Record the terms.<br />Let the committee read the evidence.</h2><p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-night/55">The merchant records the commercial terms and the supporting evidence. GenLayer validators read the evidence against those terms and publish a bounded, explainable decision.</p></div>
        <div className="mt-16 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
          <div className="relative min-h-[27rem] overflow-hidden rounded-[2rem] bg-gradient-to-br from-brand-600 via-[#3976ef] to-[#86b4fb] p-6 pb-28 text-white shadow-[0_35px_100px_rgba(25,72,180,.22)] sm:min-h-[30rem] sm:rounded-[2.5rem] sm:p-12"><div className="absolute -right-24 -top-24 size-80 rounded-full border-[40px] border-white/10" /><Eyebrow dark>For merchants</Eyebrow><h3 className="mt-7 max-w-lg font-display text-3xl font-medium leading-tight sm:text-4xl">Record the obligation and hand the evidence to the committee.</h3><p className="mt-5 max-w-md text-sm leading-relaxed text-white/70 sm:text-base">Set the amount, currency, buyer and due date, attach the evidence manifest, and let validators decide whether the evidence supports it.</p><div className="absolute bottom-6 right-6 grid size-20 place-items-center rounded-2xl border border-white/30 bg-white/15 shadow-2xl backdrop-blur-xl sm:bottom-8 sm:right-8 sm:size-28 sm:rounded-[2rem]"><ReceiptText className="size-8 stroke-[1.25] sm:size-12" /></div></div>
          <div className="grid gap-5"><div className="rounded-[2.25rem] border border-brand-100/70 bg-gradient-to-br from-white to-brand-50 p-8 shadow-[0_24px_70px_rgba(18,55,145,.08)]"><WalletCards className="size-9 stroke-[1.25] text-brand-600" /><h3 className="mt-7 font-display text-2xl font-medium tracking-[-.035em] text-night">One link shows the real state of the obligation.</h3><p className="mt-3 leading-relaxed text-night/55">Buyers open one link, read the committee decision and its reasoning, and record payment once the obligation is verified.</p></div><div className="rounded-[2.25rem] border border-brand-100/70 bg-[#f8faff] p-8 shadow-[0_24px_70px_rgba(18,55,145,.08)]"><ShieldCheck className="size-9 stroke-[1.25] text-iris-500" /><h3 className="mt-7 font-display text-2xl font-medium tracking-[-.035em] text-night">Payment follows verification.</h3><p className="mt-3 leading-relaxed text-night/55">The contract refuses to record any payment until the decision reads VERIFIED, so the merchant’s live invoice history.</p></div></div>
        </div>
      </div>
    </section>
  )
}

export function ProductPreview() {
  return (
    <section className="grain-overlay relative overflow-hidden bg-gradient-to-br from-[#eaf2ff] via-[#f8fbff] to-[#dce9ff] px-5 py-20 sm:px-6 sm:py-24">
      <div className="absolute -right-40 top-10 size-[32rem] rounded-full border-[5rem] border-white/45" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[.9fr_1.1fr] lg:gap-20">
        <div>
          <Eyebrow>Obligation review</Eyebrow>
          <h2 className="mt-6 font-display text-4xl font-medium leading-[1.04] text-night sm:text-6xl">An obligation page that explains itself.</h2>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-night/55">A buyer sees the amount, the parties, the due date, the evidence, and the committee reasoning that produced the current state.</p>
          <div className="mt-8 space-y-3">
            {[
              ['Explained decisions', 'Every decision carries a reason, a confidence band and a list of inconsistencies.'],
              ['Bounded verdicts', 'Validators must agree on the decision and confidence band before anything is written.'],
              ['Deterministic payment', 'The buyer identity and the verified state are both enforced by the contract.'],
            ].map(([title, body], index) => (
              <div key={title} className="flex gap-4 rounded-2xl border border-white/15 bg-gradient-to-br from-brand-600 to-brand-500 p-5 text-white shadow-[0_14px_38px_rgba(36,82,224,.16)]">
                <span className="shrink-0 pt-0.5 font-display text-sm font-semibold text-white/55">0{index + 1}</span>
                <p className="text-sm leading-relaxed text-white/70"><strong className="block font-display text-base font-semibold text-white">{title}</strong>{body}</p>
              </div>
            ))}
          </div>
        </div>
        <InvoiceCard />
      </div>
    </section>
  )
}

const STEPS = [{n:'01',title:'Record',body:'Connect a wallet and write the amount, currency, buyer and due date on chain.'},{n:'02',title:'Attach evidence',body:'Store the evidence manifest URL and its SHA-256 digest alongside those terms.'},{n:'03',title:'Verify',body:'Validators read the evidence against the terms and must agree on a bounded decision.'},{n:'04',title:'Pay',body:'A VERIFIED obligation accepts a payment reference from the recorded buyer.'}]
export function HowItWorks() { return <section id="how" className="scroll-mt-24 bg-white px-5 py-20 sm:px-6 sm:py-24"><div className="mx-auto max-w-6xl"><div className="max-w-3xl"><Eyebrow>How Fluxa works</Eyebrow><h2 className="mt-6 font-display text-4xl font-medium leading-[1.04] text-night sm:text-6xl">Complex infrastructure.<br />A four-step experience.</h2></div><div className="mt-10 grid gap-px overflow-hidden rounded-3xl border border-brand-100 bg-brand-100 sm:mt-16 md:grid-cols-2 lg:grid-cols-4">{STEPS.map((step)=><div key={step.n} className="group min-h-0 bg-white p-6 transition-colors hover:bg-brand-50 sm:min-h-72 sm:p-8"><span className="font-display text-sm font-semibold text-brand-500">{step.n}</span><h3 className="mt-8 font-display text-2xl font-medium text-night sm:mt-16">{step.title}</h3><p className="mt-4 text-sm leading-relaxed text-night/55">{step.body}</p><ArrowUpRight className="mt-6 size-5 text-brand-400 transition-transform group-hover:translate-x-1 group-hover:-translate-y-1 sm:mt-8" /></div>)}</div></div></section> }

export function GenLayerSection() { return <section id="genlayer" className="grain-overlay relative scroll-mt-24 overflow-hidden bg-brand-700 px-6 py-24 text-white"><div className="relative mx-auto max-w-6xl"><div className="mx-auto max-w-3xl text-center"><Eyebrow dark>Why GenLayer</Eyebrow><h2 className="mt-6 font-display text-4xl font-medium leading-[1.04] sm:text-6xl">Commercial judgment belongs onchain.</h2><p className="mt-6 text-lg leading-relaxed text-white/70">Fluxa uses intelligent contracts to evaluate unstructured evidence, reach validator consensus, and maintain an explainable obligation lifecycle.</p></div><div className="mt-16 grid gap-5 md:grid-cols-3">{[[ShieldCheck,'Evidence verification','Invoices, orders, acknowledgments, and delivery records are evaluated against a bounded policy.'],[Orbit,'Validator consensus','GenLayer validators compare structured decisions and finalize the obligation state.'],[CircleDollarSign,'Payment coordination','Only verified obligations can accept a buyer payment reference.']].map(([Icon,title,body])=>{const IconComponent=Icon as typeof Sparkles;return <div key={title as string} className="rounded-[2rem] border border-white/20 bg-white/10 p-8 shadow-2xl backdrop-blur-xl"><IconComponent className="size-9 stroke-[1.25]" /><h3 className="mt-10 font-display text-2xl font-medium">{title as string}</h3><p className="mt-3 leading-relaxed text-white/65">{body as string}</p></div>})}</div></div></section> }

export function FinalCta() { const { open }=useWalletModal(); return <section className="bg-white px-6 py-24"><div className="grain-overlay relative mx-auto max-w-6xl overflow-hidden rounded-[3rem] border border-white/25 bg-gradient-to-br from-[#174fd8] via-[#3976ef] to-[#86b4fb] px-6 py-20 text-center text-white shadow-[0_35px_100px_rgba(31,91,237,.25)] sm:px-12"><div className="absolute -left-24 top-1/2 size-64 -translate-y-1/2 rounded-full border-[2.5rem] border-white/[.07]" /><div className="absolute -right-24 -top-28 size-80 rounded-full border-[4rem] border-white/[.08]" /><div className="relative mx-auto max-w-3xl"><span className="mx-auto grid size-14 place-items-center rounded-2xl border border-white/25 bg-white/15 shadow-xl backdrop-blur-xl"><BadgeDollarSign className="size-7 stroke-[1.5] text-white" /></span><h2 className="mt-7 font-display text-4xl font-medium leading-[1.04] tracking-[-.05em] text-white sm:text-6xl">Make commercial judgment auditable.</h2><p className="mx-auto mt-6 max-w-xl text-lg text-white/70">Record the terms, attach the evidence, and let a validator committee produce a decision you can point at - all from one wallet-connected workspace.</p><Button onClick={open} size="lg" className="premium-button mt-9 bg-brand-700 px-8 text-white shadow-[0_16px_40px_rgba(12,38,109,.24)] ring-1 ring-white/20 hover:bg-brand-600">Launch Fluxa <ArrowUpRight className="size-4" /></Button></div></div></section> }

const FAQS = [
  ['What is Fluxa?', 'Fluxa turns a commercial obligation into an on-chain record with an evidence-backed decision. A merchant records the terms, validators read the evidence against them, and payment unlocks only on a VERIFIED decision.'],
  ['What keeps a decision honest?', 'The decision, confidence band and inconsistency list are bounded fields, so validators must agree on them. The model never writes prose straight into state.'],
  ['How is payment recorded?', 'The recorded buyer attaches a payment reference on chain, and only after the contract state reads VERIFIED.'],
  ['When can payment be recorded?', 'Only after the committee returns a VERIFIED decision, and only by the buyer recorded on the obligation.'],
]

export function FaqSection() { return <section className="bg-white px-6 pb-24 pt-4"><div className="mx-auto max-w-4xl"><div className="text-center"><Eyebrow>FAQ</Eyebrow><h2 className="mt-6 font-display text-4xl font-medium leading-[1.04] tracking-[-.05em] text-night sm:text-6xl">Questions, answered clearly.</h2></div><div className="mt-12 space-y-3">{FAQS.map(([question,answer])=><details key={question} className="group rounded-2xl border border-brand-100 bg-gradient-to-r from-white to-brand-50/60 px-5 py-1 shadow-[0_10px_30px_rgba(36,82,224,.05)]"><summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 font-display font-semibold text-night">{question}<span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-50 text-lg text-brand-600 transition-transform group-open:rotate-45">+</span></summary><p className="max-w-3xl pb-5 pr-10 text-sm leading-relaxed text-night/55">{answer}</p></details>)}</div></div></section> }
