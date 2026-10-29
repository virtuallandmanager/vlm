import StudioDesignPage from './client'

// One exported page for every design: the server serves /studio/<id>/ from studio/_/, and the page reads the id from the URL
export async function generateStaticParams() {
  return [{ designId: '_' }]
}

export default function Page() {
  return <StudioDesignPage />
}
