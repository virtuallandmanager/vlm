import { BroadcastIcon, ChartIcon, CubeIcon, GiftIcon, LayersIcon, ScenesIcon } from '@/components/icons'

const FEATURES = [
  { Icon: ScenesIcon, title: 'Live scene control', text: 'Edit videos, images, models and sounds from the dashboard. Visitors see the change in milliseconds.' },
  { Icon: BroadcastIcon, title: 'Live streaming', text: 'Stream from OBS to every screen in your scene. People who arrive late join the stream live.' },
  { Icon: ChartIcon, title: 'Analytics', text: "Visits, time spent, movement heatmaps and clicks, with no setup. Claim your scene's data with your wallet." },
  { Icon: GiftIcon, title: 'Events and giveaways', text: 'Schedule events and hand out NFTs to attendees across several worlds.' },
  { Icon: CubeIcon, title: 'Manage from inside the world', text: 'Place and edit things from an in-world HUD, and upload media from your phone without leaving the scene.' },
  { Icon: LayersIcon, title: 'One dashboard, many worlds', text: 'Decentraland and Hyperfy, run together from the command center.' },
]

export function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-6 px-4 py-14 sm:px-6">
      <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">Everything your scene needs, live</h2>
      <ul className="mt-10 grid gap-x-12 border-t border-gray-800 md:grid-cols-2">
        {FEATURES.map(({ Icon, title, text }) => (
          <li key={title} className="flex gap-4 border-b border-gray-800 py-6">
            <span className="mt-0.5 shrink-0 text-blue-300"><Icon size={24} /></span>
            <div>
              <h3 className="font-semibold text-white">{title}</h3>
              <p className="mt-1 max-w-md text-gray-400">{text}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-sm text-gray-500">
        Also included: media hosting, a model catalog, one-click deploy, Hyperfy world hosting, teams and roles, API keys, and self-hosting.
      </p>
    </section>
  )
}
