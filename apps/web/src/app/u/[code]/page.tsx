import CompanionUploadClient from './client'

export async function generateStaticParams() {
  return [{ code: '_' }]
}

export default function Page() {
  return <CompanionUploadClient />
}
