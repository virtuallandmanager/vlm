// Drafts the catalog tag files from downloaded source repos (never run anything from them; they're only read).
//
//   node scripts/catalog/draft-tags.mjs <repos-dir>
//
// <repos-dir> holds shallow clones of decentraland/asset-packs, decentraland/builder-assets, MrDhingia/DhingiaBuilds,
// last-slice/dcl-iwb (assets/ only) and last-slice/iwb-3d-wip (thumbnails), plus last-slice's catalog.json at
// <repos-dir>/iwb-catalog.json. Thumbnails rendered by render-thumbs.py live in <repos-dir>/thumbs/<pack>/<name>.png.
// Every path written is relative to <repos-dir>, which is the root given to catalog:import.
//
// Writes catalog/packs.json, catalog/tags/{decentraland,dhingia,last-slice}.json, catalog/review/<source>-sample.md
// and catalog/review/render-list.json (models still without a thumbnail).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOS = process.argv[2]
if (!REPOS) throw new Error('usage: draft-tags.mjs <repos-dir>')
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../catalog')
const rel = (p) => relative(REPOS, p)
const slug = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const titleCase = (s) => s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase())
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const isDir = (p) => existsSync(p) && statSync(p).isDirectory()
const ls = (p) => (isDir(p) ? readdirSync(p).filter((f) => !f.startsWith(".")) : [])

// ── Vocabulary rules ────────────────────────────────────────────────────

/** First matching rule wins; patterns run over name + caption + tags + source category, lowercased. */
const CATEGORY_RULES = [
  ['Lighting', /\b(lamps?|lights?|lanterns?|chandeliers?|torch(es)?|candles?|sconces?|bulbs?|neon|spotlights?|streetlights?)\b/],
  ['Vehicles', /\b(cars?|boats?|ships?|vehicles?|bikes?|motorcycles?|trucks?|spaceships?|airplanes?|planes?|trains?|carts?|rockets?|ufo|submarines?|helicopters?|scooters?|skateboards?|surfboards?)\b/],
  ['Characters & Animals', /\b(animals?|bears?|cats?|dogs?|birds?|fish(es)?|horses?|cows?|pigs?|chickens?|ducks?|deer|wolf|wolves|owls?|frogs?|snakes?|characters?|npcs?|avatars?|dragons?|monsters?|skeletons?|wildlife)\b/],
  ['Food & Drink', /\b(food|cakes?|coffee|cups?|mugs?|bottles?|drinks?|pizzas?|burgers?|fruits?|apples?|bananas?|bread|wine|beer|plates?|donuts?|cookies?|ice ?cream|sushi|teapots?|croissants?|cocktails?)\b/],
  ['Tech & Music', /\b(speakers?|dj|turntables?|screens?|tvs?|television|monitors?|computers?|laptops?|arcade|consoles?|guitars?|pianos?|drums?|microphones?|mics?|amps?|amplifiers?|keyboards?|robots?|servers?|phones?|radios?|jukebox(es)?|projectors?)\b/],
  ['Signage', /\b(signs?|signage|billboards?|banners?|posters?|letters?|alphabet|lettering|typography|logos?|arrows?|ui|user interface|buttons?|panels?|numbers?|digits?|frames? ui)\b/],
  ['Effects', /\b(vfx|particles?|smoke|fire|flames?|sparkles?|portals?|lasers?|fog|explosions?|magic)\b/],
  ['Furniture', /\b(chairs?|armchairs?|sofas?|couch(es)?|tables?|desks?|beds?|benches?|stools?|shelf|shelves|cabinets?|seats?|counters?|wardrobes?|dressers?|drawers?|bookcases?|bookshelf|ottomans?|thrones?|hammocks?|loungers?|furniture)\b/],
  ['Plants & Nature', /\b(trees?|bush(es)?|plants?|flowers?|grass|rocks?|boulders?|palms?|cactus|cacti|ferns?|foliage|mushrooms?|logs?|leaves|vines?|hedges?|shrubs?|nature|botanical|stumps?|coral)\b/],
  ['Building', /\b(buildings?|houses?|towers?|castles?|temples?|huts?|cabins?|palaces?|warehouses?|churches?|lighthouses?|mansions?|skyscrapers?|cottages?|pagodas?|shops? building|stores? building|forts?|fortress|barns?|shacks?)\b/],
  ['Structure', /\b(stages?|walls?|floors?|stairs?|staircases?|steps|roofs?|fences?|doors?|windows?|pillars?|columns?|arch(es)?|platforms?|bridges?|tiles?|ground|gates?|railings?|ramps?|beams?|planks?|blocks?|bricks?|terrain|paths?|roads?|structures?)\b/],
  ['Decor', /\b(decor|decorations?|rugs?|carpets?|vases?|paintings?|clocks?|pots?|crates?|barrels?|box(es)?|statues?|sculptures?|pillows?|cushions?|curtains?|mirrors?|books?|baskets?|trophies|trophy|chests?|ornaments?|fountains?|flags?|balloons?|umbrellas?|whiteboards?|erasers?|spoons?|tools?|hatchets?|axes|shovels?|screwdrivers?|wrench(es)?|hammers?|tire iron|med ?kits?|compass(es)?|spray cans?|magnifying glass|pull-up bars?)\b/],
]

const VENUE_RULES = [
  ['cafe', /\b(coffee|cafe|café|espresso|cups?|mugs?|croissants?|pastr(y|ies)|teapots?|menu)\b/],
  ['restaurant', /\b(dining|restaurant|plates?|kitchen|cutlery|stove|oven|food|pizza|burger|sushi)\b/],
  ['bar', /\b(bar|beer|wine|bottles?|cocktails?|stools?|kegs?|pub|tavern|saloon)\b/],
  ['club', /\b(dj|speakers?|neon|disco|club|clubhouse|dance|lasers?|turntables?|pole)\b/],
  ['stage', /\b(stage|microphones?|mics?|amps?|guitars?|drums?|spotlights?|concert|podium|rock show|seminar|presentation)\b/],
  ['gallery', /\b(gallery|frames?|paintings?|pedestals?|plinths?|sculptures?|statues?|exhibit|nft)\b/],
  ['museum', /\b(museum|exhibit|statues?|artifacts?|display case|fossils?|monuments?)\b/],
  ['shop', /\b(shop|store|shelf|shelves|mannequins?|racks?|register|display|kiosks?|stalls?|market|commercial)\b/],
  ['office', /\b(office|whiteboards?|desks?|computers?|monitors?|filing|whiteboards?|printers?|laptops?|seminar)\b/],
  ['home', /\b(beds?|sofas?|couch(es)?|kitchen|bath(tub)?|toilets?|fireplaces?|rugs?|home|house|living|bedroom|interior|armchairs?)\b/],
  ['outdoor', /\b(outdoor|trees?|bush(es)?|fences?|benches?|street|rocks?|grass|garden|landscape|terrain)\b/],
  ['park', /\b(park|playground|fountains?|benches?|picnic|parks and recreation|skatepark|recreation)\b/],
  ['beach', /\b(beach|palms?|umbrellas?|surf(boards?)?|sand|lifeguard|shells?|tropical|paradise|beach club)\b/],
  ['gym', /\b(gym|dumbbells?|treadmills?|weights?|fitness|yoga|barbells?|pull-up bars?)\b/],
]
/** Plain seating and tables fit most indoor venues. */
const SEATING = /\b(chairs?|tables?|stools?|seats?|benches?|sofas?|couch(es)?)\b/

const STYLE_WORDS = [
  ['Cyberpunk', /\bcyber(punk)?\b/], ['Sci-Fi', /\b(sci-?fi|space|futuristic|alien)\b/], ['Fantasy', /\bfantasy\b/],
  ['Western', /\bwestern|cowboy\b/], ['Steampunk', /\bsteampunk\b/], ['Pirates', /\bpirates?\b/], ['Asian', /\b(asian|chinese|japanese|arabic)\b/],
  ['Halloween', /\bhalloween|spooky\b/], ['Voxel', /\bvoxels?\b/], ['Industrial', /\bindustrial\b/], ['Minimalist', /\bminimal(ist)?\b/], ['Cozy', /\bcozy|cosy\b/],
]

/**
 * The source's own category wins, except Decor (too generic: keywords refine it) and Structure (keywords may say
 * it's a whole Building). With no source category, keywords decide, else 'Other'.
 */
function categoryFor(text, sourceCategory = null) {
  const words = text.replace(/building blocks?/g, 'block')
  const kw = CATEGORY_RULES.find(([, re]) => re.test(words))?.[0] ?? null
  if (sourceCategory && sourceCategory !== 'Decor') {
    if (sourceCategory === 'Structure' && kw === 'Building') return { category: 'Building', sure: true }
    return { category: sourceCategory, sure: true }
  }
  if (kw) return { category: kw, sure: true }
  return sourceCategory ? { category: sourceCategory, sure: false } : { category: 'Other', sure: false }
}
function venuesFor(text, category) {
  const v = new Set(VENUE_RULES.filter(([, re]) => re.test(text)).map(([venue]) => venue))
  if (category === 'Furniture' && SEATING.test(text)) for (const x of ['cafe', 'restaurant', 'home']) v.add(x)
  return [...v]
}
const styleFromWords = (text) => STYLE_WORDS.find(([, re]) => re.test(text))?.[0] ?? null

/** confidence: 1 = all from the source, lower when guessed. Rows under 0.6 go to the review sample. */
function tag(text, { style, styleSure, sourceCategory, venueText = '' }) {
  const { category, sure } = categoryFor(text, sourceCategory)
  const venueTags = venuesFor(`${text} ${venueText}`, category)
  let confidence = 1
  if (!sourceCategory && !sure) confidence = 0.3
  else if (!sure) confidence = 0.7
  else if (!sourceCategory) confidence = 0.8
  if (!styleSure) confidence = Math.min(confidence, 0.8)
  return { style, category, venueTags, confidence: Math.round(confidence * 100) / 100 }
}

// ── Packs ───────────────────────────────────────────────────────────────

const MIT = readJson(join(OUT, 'packs.json')).find((p) => p.id === 'dhingia-buildings').attribution
const packs = new Map()
const addPack = (p) => { if (!packs.has(p.id)) packs.set(p.id, p) }

// ── Decentraland: Creator Hub packs, then the old Builder packs ─────────

const DCL_STYLE = {
  cyberpunk: 'Cyberpunk', fantasy: 'Fantasy', gallery: null, genesis_city: 'Modern', halloween: 'Halloween', pirates: 'Pirates',
  'sci-fi': 'Sci-Fi', steampunk: 'Steampunk', voxels_pack: 'Voxel', western: 'Western', year_of_the_pig: 'Asian',
}
const DCL_CATEGORY = {
  furniture: 'Furniture', nature: 'Plants & Nature', tiles: 'Structure', ground: 'Structure', platforms: 'Structure', doors: 'Structure',
  seats: 'Furniture', lights: 'Lighting', text: 'Signage', chests: 'Decor', decorations: 'Decor', structures: 'Structure', media: 'Tech & Music',
}
const SKIP_DCL_PACKS = new Set(['smart_items']) // interactive items: their behavior doesn't come with the model
const SKIP_DCL_CATEGORIES = new Set(['sounds', 'buttons', 'levers', 'utils', 'health', 'primitives', 'empty land', 'deprecated', 'pyrotechnics', 'social'])

function draftDecentraland() {
  const rows = []
  const hub = join(REPOS, 'asset-packs/packs')
  for (const packDir of ls(hub)) {
    if (SKIP_DCL_PACKS.has(packDir) || !isDir(join(hub, packDir))) continue
    const meta = readJson(join(hub, packDir, 'data.json'))
    const id = `dcl-${slug(packDir)}`
    addPack({ id, name: `Decentraland: ${meta.name}`, source: 'decentraland', license: 'unstated', attribution: 'Decentraland Foundation (Creator Hub asset packs)', sourceUrl: 'https://github.com/decentraland/asset-packs' })
    for (const a of ls(join(hub, packDir, 'assets'))) {
      const dir = join(hub, packDir, 'assets', a)
      const glbs = ls(dir).filter((f) => f.toLowerCase().endsWith('.glb'))
      if (glbs.length !== 1 || !existsSync(join(dir, 'data.json'))) continue // no model, or several parts of one smart item
      const d = readJson(join(dir, 'data.json'))
      const cat = (d.category ?? '').toLowerCase()
      if (SKIP_DCL_CATEGORIES.has(cat)) continue
      const text = [d.name, d.caption, ...(d.tags ?? []), cat].join(' ').toLowerCase()
      const style = DCL_STYLE[packDir] ?? styleFromWords(text)
      rows.push({
        pack: id, sourceRef: `${packDir}/${a}`, file: rel(join(dir, glbs[0])), thumbnail: existsSync(join(dir, 'thumbnail.png')) ? rel(join(dir, 'thumbnail.png')) : undefined,
        name: d.name, description: d.caption || undefined, author: d.author || 'Decentraland Foundation',
        ...tag(text, { style, styleSure: packDir in DCL_STYLE && DCL_STYLE[packDir] !== null, sourceCategory: DCL_CATEGORY[cat] ?? null }),
      })
    }
  }
  const BUILDER_STYLE = { '00_SciFi_Pack': 'Sci-Fi', '01_MiniTown': 'Modern', '02_Pirates': 'Pirates', '03_HTC_Pack': 'Sci-Fi', '04_Chinese_Pack': 'Asian', '05_Fantasy_Pack': 'Fantasy' }
  const builder = join(REPOS, 'builder-assets/assets')
  for (const packDir of ls(builder)) {
    if (!isDir(join(builder, packDir))) continue
    const id = `dcl-builder-${slug(packDir.replace(/^\d+_/, '').replace(/_Pack$/, ''))}`
    addPack({ id, name: `Decentraland Builder: ${titleCase(packDir.replace(/^\d+_/, '').replace(/_Pack$/, ''))}`, source: 'decentraland', license: 'cc-by-nc-3.0', attribution: 'Decentraland, licensed CC BY-NC 3.0', sourceUrl: 'https://github.com/decentraland/builder-assets' })
    for (const a of ls(join(builder, packDir))) {
      const dir = join(builder, packDir, a)
      const glbs = ls(dir).filter((f) => f.toLowerCase().endsWith('.glb'))
      if (glbs.length !== 1 || !existsSync(join(dir, 'asset.json'))) continue
      const d = readJson(join(dir, 'asset.json'))
      const cat = (d.category ?? '').toLowerCase()
      const text = [d.name, ...(d.tags ?? []), cat].join(' ').toLowerCase()
      rows.push({
        pack: id, sourceRef: `${packDir}/${a}`, file: rel(join(dir, glbs[0])), thumbnail: existsSync(join(dir, 'thumbnail.png')) ? rel(join(dir, 'thumbnail.png')) : undefined,
        name: d.name || titleCase(a), author: 'Decentraland',
        ...tag(text, { style: BUILDER_STYLE[packDir] ?? styleFromWords(text), styleSure: packDir in BUILDER_STYLE, sourceCategory: DCL_CATEGORY[cat] ?? null }),
      })
    }
  }
  return rows
}

// ── Mr Dhingia ──────────────────────────────────────────────────────────

const DHINGIA_URL = 'https://github.com/MrDhingia/DhingiaBuilds'
const DJ_ASSET = /\b(dj|speaker|pole|booth|asset)\b/i
/** SDK sample parts in the "with SDK" builds: interactive or demo pieces, not models to offer. */
const SDK_PART = /^(button|alice)$/i
/** The main model of a "with SDK" build, as opposed to its light rigs and stages. */
const SDK_MAIN = /(final|^bn\d+|arabic)/i

function walkGlbs(dir) {
  return ls(dir).flatMap((f) => {
    const p = join(dir, f)
    if (isDir(p)) return f === 'node_modules' ? [] : walkGlbs(p)
    return f.toLowerCase().endsWith('.glb') ? [p] : []
  })
}

function draftDhingia() {
  const root = join(REPOS, 'DhingiaBuilds')
  addPack({ id: 'dhingia-buildings', name: 'Mr Dhingia: Buildings', source: 'dhingia', license: 'mit', attribution: MIT, sourceUrl: DHINGIA_URL })
  addPack({ id: 'dhingia-interiors', name: 'Mr Dhingia: Interiors', source: 'dhingia', license: 'mit', attribution: MIT, sourceUrl: DHINGIA_URL })
  addPack({ id: 'dhingia-dj', name: 'Mr Dhingia: DJ & Club Kit', source: 'dhingia', license: 'mit', attribution: MIT, sourceUrl: DHINGIA_URL })
  const rows = []
  for (const folder of ls(root)) {
    const dir = join(root, folder)
    if (!isDir(dir) || folder.startsWith('.')) continue
    const render = ls(dir).find((f) => /^(render.*|scene-thumbnail)\.png$/i.test(f))
    for (const file of walkGlbs(dir)) {
      const stem = basename(file, extname(file)).replace(/[_]+/g, ' ')
      if (SDK_PART.test(stem)) continue
      const sdkPart = /\/models\//i.test(file) && !SDK_MAIN.test(stem)
      const build = folder.match(/^Dhingia Builds (\d+)/)
      const text = `${folder} ${stem}`.toLowerCase()
      let pack, name, category, sourceCategory
      if (folder === 'Interior assets for builds') {
        pack = 'dhingia-interiors'; name = stem; sourceCategory = null
      } else if (folder === 'Pole dance assets' || DJ_ASSET.test(stem) || sdkPart) {
        pack = 'dhingia-dj'; name = titleCase(stem.replace(/\basset\b/gi, '')); sourceCategory = null
      } else if (build) {
        pack = 'dhingia-buildings'
        const extra = folder.replace(/^Dhingia Builds \d+\s*/, '').replace(/Size \d+x\d+/i, '').replace(/with SDK/i, '').replace(/[-\s]+$/, '').trim()
        // The variant is what's left of the file name once the build number, size and boilerplate are gone ("Blue")
        const variant = stem.replace(/dhingia builds?|size|\d+x\d+|final|build|\b\d+\b/gi, '').replace(/\s+/g, ' ').trim()
        const sdkMain = /\/models\//i.test(file)
        const parcels = (stem.match(/\d+x\d+/) ?? folder.match(/\d+x\d+/))?.[0]
        name = `Dhingia Build ${build[1]}${extra ? ` ${extra}` : ''}${variant && !sdkMain ? ` ${titleCase(variant)}` : ''}${parcels ? ` (${parcels})` : ''}`
        category = 'Building'
      } else continue
      const style = styleFromWords(text)
      const t = category
        ? { style, category, venueTags: venuesFor(text, category), confidence: 0.8 }
        : tag(text, { style, styleSure: false, sourceCategory })
      const size = folder.match(/Size (\d+x\d+)/i)
      const thumb = render && pack === 'dhingia-buildings' ? rel(join(dir, render)) : renderedThumb(pack, rel(file))
      rows.push({
        pack, sourceRef: relative(root, file), file: rel(file), thumbnail: thumb, name,
        description: size ? `Fits a ${size[1]} parcel area` : undefined, author: 'Mr Dhingia', ...t,
      })
    }
  }
  return rows
}

// ── Last Slice (In World Builder) ───────────────────────────────────────

const LS_STYLE = {
  'Cyberpunk': 'Cyberpunk', 'Sci-Fi & Space': 'Sci-Fi', 'Western': 'Western', 'Fantasy': 'Fantasy', 'City & Commercial': 'Modern',
  'Parks & Recreation': 'Nature', 'House/Modern': 'Modern', 'Pirates': 'Pirates', 'Steampunk': 'Steampunk', 'Animals & Wildlife': 'Nature',
  'Voxels': 'Voxel', 'Asian': 'Asian', 'Old Fashioned': 'Classic', 'Weather/Environment': 'Nature', 'Holiday': null, 'Anime': null,
  'Food': null, 'Gallery/Venue': null, 'Building Block': null, 'UI': null, 'User Interface': null, 'UI / VFX': null,
}
const LS_CATEGORY = {
  'Furniture': 'Furniture', 'Nature': 'Plants & Nature', 'Building Block': 'Structure', 'Structures': 'Structure', 'Ground': 'Structure',
  'Tiles': 'Structure', 'Food': 'Food & Drink', 'Animals & Wildlife': 'Characters & Animals', 'NPCs': 'Characters & Animals',
  'User Interface': 'Signage', 'UI': 'Signage', 'Decorations': 'Decor', 'Wood': 'Structure', 'Construction': 'Structure', 'Elevator': 'Structure',
}
const UI_STYLES = new Set(['UI', 'User Interface', 'UI / VFX'])
// The IWB minigame kit (weapons, ammo, pickups, checkpoints, spawn markers) does nothing without game code: it gets
// its own pack that starts switched off
const GAME_KIT = /^(Scifi|Steampunk|Anime|Candy) (Blaster|Rifle|Sword|Shield|Bullet|Checkpoint|Finish|Pick ?Up|Pickup|Grenade)|^Weapon Anime$|^Indicator (Spawn Area|Heart)/i

function draftLastSlice() {
  const catalog = readJson(join(REPOS, 'iwb-catalog.json')).filter((i) => i.ty === '3D' && i.on !== 'Decentraland')
  const assets = join(REPOS, 'dcl-iwb/assets')
  const wip = join(REPOS, 'iwb-3d-wip')
  const wipFolder = new Map(ls(wip).filter((f) => isDir(join(wip, f))).map((f) => [f.toLowerCase().replace(/\s+/g, ''), f]))
  const rows = []
  for (const i of catalog) {
    const file = join(assets, `${i.id}.glb`)
    if (!existsSync(file)) continue
    const artist = i.on
    const ui = UI_STYLES.has(i.sty)
    const id = `last-slice-${slug(artist)}${ui ? '-ui' : ''}`
    addPack({
      id, name: `Last Slice: ${artist}${ui ? ' (UI pieces)' : ''}`, source: 'last-slice', license: 'unstated',
      attribution: `${artist} for the In World Builder by Last Slice`, sourceUrl: 'https://github.com/last-slice/dcl-iwb',
    })
    const text = [i.n, i.d, i.cat, ...(i.tag ?? [])].join(' ').toLowerCase()
    const folder = wipFolder.get(artist.toLowerCase().replace(/\s+/g, ''))
    const wipThumb = folder && i.m ? join(wip, folder, `${i.m}.png`) : null
    const thumb = wipThumb && existsSync(wipThumb) ? rel(wipThumb) : renderedThumb(id, rel(file))
    const kit = GAME_KIT.test(i.n.trim())
    if (kit) addPack({
      id: 'last-slice-game-kit', name: 'Last Slice: Game kit', source: 'last-slice', license: 'unstated',
      attribution: 'Last Slice In World Builder artists', sourceUrl: 'https://github.com/last-slice/dcl-iwb', enabled: false,
    })
    const style = i.sty in LS_STYLE ? LS_STYLE[i.sty] : styleFromWords(text)
    const t = tag(text, { style, styleSure: i.sty in LS_STYLE, sourceCategory: LS_CATEGORY[i.cat] ?? (ui ? 'Signage' : null), venueText: (i.sty ?? '').toLowerCase() })
    // Last Slice's venue categories (Beach Club, Gym, Rock Show…) are themselves venue tags
    rows.push({
      pack: kit ? 'last-slice-game-kit' : id, sourceRef: i.id, file: rel(file), thumbnail: thumb,
      name: i.n.trim() || titleCase(i.m || i.id), description: i.d?.trim() || undefined, author: artist, ...t,
    })
  }
  return rows
}

// ── Thumbnails still to render ──────────────────────────────────────────

const toRender = []
function renderedThumb(pack, glbRel) {
  const out = `thumbs/${pack}/${slug(glbRel)}.png`
  if (existsSync(join(REPOS, out))) return out
  toRender.push({ glb: glbRel, out })
  return undefined
}

// ── Output ──────────────────────────────────────────────────────────────

function review(source, rows) {
  const byPack = new Map()
  for (const r of rows) byPack.set(r.pack, [...(byPack.get(r.pack) ?? []), r])
  const line = (r) => `| ${r.name.replace(/\|/g, '/')} | ${r.style ?? '—'} | ${r.category} | ${r.venueTags.join(', ') || '—'} | ${r.confidence} |`
  const head = '| Model | Style | Category | Venues | Confidence |\n|---|---|---|---|---|'
  let md = `# ${source}: tag review\n\n${rows.length} models in ${byPack.size} packs. Correct anything wrong in catalog/tags/${source}.json (or tell Claude).\n`
  const unsure = rows.filter((r) => r.confidence < 0.6)
  md += `\n## Unsure (${unsure.length})\n\nThese got 'Other' or a guessed category.\n\n${head}\n${unsure.map(line).join('\n')}\n`
  for (const [pack, list] of byPack) {
    const step = Math.max(1, Math.floor(list.length / 8))
    md += `\n## ${pack} (${list.length}): sample\n\n${head}\n${list.filter((_, i) => i % step === 0).slice(0, 8).map(line).join('\n')}\n`
  }
  return md
}

mkdirSync(join(OUT, 'tags'), { recursive: true })
mkdirSync(join(OUT, 'review'), { recursive: true })
const sources = { decentraland: draftDecentraland(), dhingia: draftDhingia(), 'last-slice': draftLastSlice() }
for (const [source, rows] of Object.entries(sources)) {
  writeFileSync(join(OUT, 'tags', `${source}.json`), JSON.stringify(rows, null, 1) + '\n')
  writeFileSync(join(OUT, 'review', `${source}-sample.md`), review(source, rows))
  const unsure = rows.filter((r) => r.confidence < 0.6).length
  console.log(`${source}: ${rows.length} rows, ${unsure} unsure, ${rows.filter((r) => !r.thumbnail).length} without thumbnail`)
}
writeFileSync(join(OUT, 'packs.json'), JSON.stringify([...packs.values()], null, 2) + '\n')
writeFileSync(join(OUT, 'review', 'render-list.json'), JSON.stringify(toRender, null, 1) + '\n')
console.log(`${packs.size} packs; ${toRender.length} thumbnails to render`)
