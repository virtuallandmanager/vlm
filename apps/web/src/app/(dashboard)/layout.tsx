'use client'
import { useAuth } from '@/lib/auth'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useMemo } from 'react'
import Link from 'next/link'

const baseNavItems = [
  { href: '/scenes', label: 'Scenes' },
  { href: '/events', label: 'Events' },
  { href: '/giveaways', label: 'Giveaways' },
  { href: '/media', label: 'Media' },
  { href: '/streaming', label: 'Streaming' },
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
    if (!loading && !user) router.push('/')
  }, [user, loading, router])

  if (loading) return <div className="flex h-screen items-center justify-center"><p>Loading...</p></div>
  if (!user) return null

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r border-gray-800 bg-gray-900 p-4 flex flex-col">
        <h2 className="text-lg font-bold mb-6">VLM</h2>
        <nav className="flex-1 space-y-1">
          {navItems.map(item => (
            <Link key={item.href} href={item.href}
              className={`block rounded-lg px-3 py-2 text-sm ${pathname.startsWith(item.href) ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800/50'}`}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-gray-800 pt-4 mt-4">
          <p className="text-sm text-gray-400 truncate">{user.displayName}</p>
          <button onClick={logout} className="mt-2 text-xs text-gray-500 hover:text-white">Sign Out</button>
        </div>
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  )
}
