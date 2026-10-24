import HeadsetPairClient from './client'

// Static export has one page for every code; the client reads the real code from the address bar.
export async function generateStaticParams() {
  return [{ code: '_' }]
}

export default function Page() {
  return <HeadsetPairClient />
}
