// Shared dashboard pieces for the graphite + cyan look.
import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** The page's main call to action: bright cyan with a clipped corner. Use one per page. */
export function PrimaryButton({ className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      {...rest}
      className={`clip-corner inline-flex items-center gap-1.5 bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  )
}

/** Breadcrumb, title with an optional count badge, subtitle, and the page's actions on the right. */
export function PageHeader({ crumbs, title, count, subtitle, actions }: { crumbs?: string[]; title: string; count?: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 border-b border-gray-800 pb-6">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-3 text-sm text-gray-500">
          {crumbs.map((c, i) => (
            <span key={c}>
              {i > 0 && <span className="mx-2 text-gray-600">/</span>}
              <span className={i === crumbs.length - 1 ? 'text-gray-200' : ''}>{c}</span>
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{title}</h1>
            {count !== undefined && <span className="rounded bg-gray-800 px-2 py-1 font-mono text-sm text-blue-300">{count}</span>}
          </div>
          {subtitle && <p className="mt-2 text-gray-400">{subtitle}</p>}
        </div>
        {actions}
      </div>
    </header>
  )
}
