import { Link } from 'react-router';
import { Icons } from '@/components/icons';
import { paths } from '@/routes';

/**
 * 404, in the blue design system — it renders inside AppLayout, so it matches the
 * rest of the workspace rather than the old dark card.
 */
export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-lg py-10 text-center">
      <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-brand-50 text-brand-600">
        <Icons.receipt className="size-8" />
      </div>
      <p className="mt-5 font-display text-5xl font-bold tracking-tight text-night">404</p>
      <h1 className="mt-2 font-display text-xl font-semibold text-night">Page not found</h1>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-night/55">
        That page doesn’t exist, or the link has moved. Let’s get you back to your invoices.
      </p>
      <Link
        to={paths.invoices}
        className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand-600 px-5 text-sm font-semibold text-white shadow-sm shadow-brand-900/20 transition-colors hover:bg-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2"
      >
        <Icons.arrowRight className="size-4 rotate-180" />
        Back to invoices
      </Link>
    </div>
  );
}
