const POINTS = [
  { title: 'Any screen becomes an ad space', text: 'Play ads, or your own playlist with ads in between. Or place a standalone billboard.' },
  { title: 'Ads never interrupt your stream', text: "Video ads step aside while you're live, and come back when you finish." },
  { title: 'Muted video ads, labelled and capped', text: 'Every ad is marked as an ad, and no visitor sees the same one over and over.' },
]

export function EarnBand() {
  return (
    <section className="border-y border-blue-800 bg-blue-950/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1fr_1.4fr]">
        <div>
          <p className="mb-3 text-sm font-medium text-blue-300">Earn from your scene</p>
          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Your scene can pay you</h2>
          <p className="mt-4 max-w-md leading-relaxed text-gray-300">
            Turn your screens into ad spaces and you're paid for the campaigns we place in your scene. When there's no campaign, VLM's own
            ads fill the slot, so it's never a blank panel.
          </p>
        </div>
        <ul className="grid gap-6 sm:grid-cols-3">
          {POINTS.map((p) => (
            <li key={p.title} className="border-t-2 border-accent pt-4">
              <h3 className="font-semibold text-white">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-400">{p.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
