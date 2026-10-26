const LEVELS = [
  { title: 'In scene', text: 'The visitor was there while your ad was showing.' },
  { title: 'On screen', text: 'Your ad was in view and close enough to read. This is what campaigns are measured by.', key: true },
  { title: 'Looked at', text: "The visitor's crosshair rested on your ad." },
  { title: 'Clicked', text: 'The visitor opened your link.' },
]

export function Measurement({ onAdvertise }: { onAdvertise: () => void }) {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">Ads that prove they were seen</h2>
      <p className="mt-3 max-w-xl text-gray-400">Every campaign report counts four levels, from the broadest to the strongest.</p>
      <ol className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {LEVELS.map((l, i) => (
          <li
            key={l.title}
            className={`rounded-lg border p-5 ${l.key ? 'border-accent bg-blue-950/60' : 'border-gray-800 bg-gray-900'}`}
          >
            <span className={`text-sm font-medium ${l.key ? 'text-blue-300' : 'text-gray-500'}`}>Level {i + 1}</span>
            <h3 className="mt-1 text-lg font-semibold text-white">{l.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">{l.text}</p>
          </li>
        ))}
      </ol>
      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
        <button type="button" onClick={onAdvertise} className="clip-corner bg-accent px-6 py-3 font-semibold text-accent-ink hover:bg-accent-hover">
          Advertise with Virvi →
        </button>
        <p className="text-sm text-gray-500">Counted from verified wallets only, once per day.</p>
      </div>
    </section>
  )
}
