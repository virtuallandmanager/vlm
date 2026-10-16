'use client'
import { useAuth } from '@/lib/auth'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useMemo } from 'react'
import Link from 'next/link'

const baseNavItems = [
  { href: '/command-center', label: 'Command Center' },
  { href: '/scenes', label: 'Scenes' },
  { href: '/events', label: 'Events' },
  { href: '/giveaways', label: 'Giveaways' },
  { href: '/media', label: 'Media' },
  { href: '/assets', label: 'Assets' },
  { href: '/streaming', label: 'Streaming' },
  { href: '/deploy', label: 'Deploy' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/settings', label: 'Settings' },
]

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  const navItems = useMemo(() => {
    const items = [...baseNavItems]
    if (user?.role === 'admin') {
      items.push({ href: '/admin', label: 'Admin' })
    }
    return items
  }, [user?.role])

  useEffect(() => {
    if (!loading && !user) {
      const here = window.location.pathname + window.location.search
      router.push(`/?next=${encodeURIComponent(here)}`)
    }
  }, [user, loading, router])

  if (loading) return <div className="flex h-screen items-center justify-center"><p>Loading...</p></div>
  if (!user) return null

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="w-full shrink-0 border-b border-gray-800 bg-gray-900 p-4 flex flex-col md:w-56 md:border-b-0 md:border-r">
        <h2 className="text-lg font-bold mb-3 md:mb-6">VLM</h2>
        <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 md:mx-0 md:block md:flex-1 md:space-y-1 md:overflow-visible md:px-0">
          {navItems.map(item => (
            <Link key={item.href} href={item.href}
              className={`block shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm ${pathname.startsWith(item.href) ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800/50'}`}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-gray-800 pt-4 mt-4 flex items-center justify-between gap-3 md:block">
          <p className="text-sm text-gray-400 truncate">{user.displayName}</p>
          <button onClick={logout} className="shrink-0 md:mt-2 text-xs text-gray-500 hover:text-white">Sign Out</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
    </div>
  )
}
