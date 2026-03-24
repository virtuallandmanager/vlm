import SceneEditorPage from './client'

export async function generateStaticParams() {
  return [{ sceneId: '_' }]
}

export default function Page() {
  return <SceneEditorPage />
}
