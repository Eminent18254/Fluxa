import {
  ArrowLeftRight,
  BookOpen,
  ArrowRight,
  Check,
  Clock3,
  Coins,
  Globe2,
  Link2,
  RadioTower,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  WalletCards,
  Zap,
} from 'lucide-react'

export const Icons = {
  bolt: Zap,
  shield: ShieldCheck,
  link: Link2,
  globe: Globe2,
  clock: Clock3,
  coins: Coins,
  receipt: ReceiptText,
  wallet: WalletCards,
  network: RadioTower,
  check: Check,
  arrowRight: ArrowRight,
  spark: Sparkles,
  swap: ArrowLeftRight,
  book: BookOpen,
} as const

export type IconName = keyof typeof Icons
