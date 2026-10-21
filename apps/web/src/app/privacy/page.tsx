import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy — VLM',
  description: 'What VLM collects in Decentraland scenes and from the advertiser early-access form, and how to have it removed.',
}

// Keep in step with apps/docs/src/content/docs/privacy.md
export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-950 px-4 py-12 sm:px-6">
      <article className="mx-auto max-w-2xl text-gray-300 [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-white [&_li]:mt-2 [&_p]:leading-relaxed">
        <a href="/" className="text-sm text-gray-400 hover:text-white">← Back to VLM</a>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">Privacy and visitor data</h1>

        <h2>What is collected</h2>
        <p>
          When a scene uses VLM, the scene sends anonymous usage events to VLM while you're inside its parcels: when you arrive and leave, where
          you walk (sampled every few seconds), what you click or hover, videos you play, emotes, and camera mode.
        </p>

        <h2>How you're identified</h2>
        <ul className="list-disc pl-5">
          <li>
            By default VLM stores a <strong>per-scene pseudonym</strong>: a keyed hash of your wallet (or guest id). It can't be linked across
            scenes and it isn't your wallet address.
          </li>
          <li>
            <strong>Display names and wallet addresses are only stored</strong> if the scene owner turns on wallet visibility. When they do, the
            scene shows a notice when you enter, and only data collected after that notice includes your wallet and name.
          </li>
          <li>
            <strong>IP addresses are never stored.</strong> VLM uses them briefly to limit abuse and to look up your country, then discards them.
          </li>
        </ul>

        <h2>Retention</h2>
        <p>
          Raw events are kept for the scene owner's plan (7–365 days, unlimited on the top tier and self-hosted installs), 30 days for unclaimed
          scenes, and 7 days for local previews. Aggregated statistics (counts, heatmaps) are kept longer and contain no identities.
        </p>

        <h2>Deleting your data</h2>
        <p>
          Call <code className="rounded bg-gray-800 px-1.5 py-0.5 text-sm">POST /api/analytics/me/delete</code> with your session token. A
          dashboard control for this is coming. This removes your sessions, events and positions from every scene.
        </p>

        <h2>Advertiser early access</h2>
        <p>
          When you ask for advertising early access on vlm.gg, VLM stores the email address, name, company or project, website and message you
          enter, and the time you sent the form. It's used only to contact you about advertising on VLM. If you send the form again with the same
          email, the new answers replace the old ones (fields you leave blank keep what you sent before). Your IP address is used briefly to
          limit repeated submissions and is not stored. To be removed from the list, email{' '}
          <a href="mailto:sales@vlm.gg" className="text-blue-400 hover:underline">sales@vlm.gg</a>.
        </p>
      </article>
    </div>
  )
}
