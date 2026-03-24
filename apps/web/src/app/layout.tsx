import type { Metadata } from 'next'
import '@/styles/globals.css'
import { AuthProvider } from '@/lib/auth'

export const metadata: Metadata = {
  title: 'VLM — Virtual Land Manager',
  description: 'Manage your metaverse scenes',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-white">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  )
}
