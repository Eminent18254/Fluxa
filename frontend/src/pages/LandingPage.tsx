import { LandingNav } from '@/components/landing/Nav'
import { Hero } from '@/components/landing/Hero'
import {
  Features,
  ProductPreview,
  HowItWorks,
  FlareSection,
  FinalCta,
  FaqSection,
} from '@/components/landing/Sections'
import { Footer } from '@/components/landing/Footer'

/**
 * The public front door. Unlike the merchant workspace it takes no shell and no
 * wallet — it renders for anyone, and its only real action is the wallet modal
 * (opened from the nav and the CTAs). Sections alternate blue/light bands to
 * match the reference, with the wave ribbon carrying the hero into the page.
 */
export function LandingPage() {
  return (
    <div className="min-h-dvh bg-paper">
      <LandingNav />
      <main>
        <Hero />
        <div className="landing-reveal"><Features /></div>
        <div className="landing-reveal"><ProductPreview /></div>
        <div className="landing-reveal"><HowItWorks /></div>
        <div className="landing-reveal"><FlareSection /></div>
        <div className="landing-reveal"><FaqSection /></div>
        <div className="landing-reveal"><FinalCta /></div>
      </main>
      <Footer />
    </div>
  )
}
