/**
 * Curated starter content for the New Scene Wizard. A theme is a short list of catalog items laid out on a
 * unit plot (x and z are fractions 0..1 of the plot, z=0 the south edge where players spawn, rotationY in
 * degrees); it scales to whatever plot size is chosen. A chip is the short pick-list behind a category button.
 * Hand-drafted from catalog/tags/*.json and reviewed by the owner; items are ordered most-important first
 * because trimming to a budget drops from the end.
 */

export interface ThemeItemRef {
  pack: string
  sourceRef: string
  x: number
  z: number
  rotationY: number
}

export interface Theme {
  id: string
  name: string
  items: ThemeItemRef[]
}

export interface CategoryChip {
  id: string
  label: string
  /** Catalog `category` values this chip lists. */
  categories: string[]
  picks: Array<{ pack: string; sourceRef: string }>
}

type Ref = { pack: string; sourceRef: string }

const mini = (n: string): Ref => ({ pack: 'dcl-builder-minitown', sourceRef: `01_MiniTown/${n}` })
const fantasy = (n: string): Ref => ({ pack: 'dcl-builder-fantasy', sourceRef: `05_Fantasy_Pack/${n}` })
const chinese = (n: string): Ref => ({ pack: 'dcl-builder-chinese', sourceRef: `04_Chinese_Pack/${n}` })
const scifi = (n: string): Ref => ({ pack: 'dcl-builder-scifi', sourceRef: `00_SciFi_Pack/${n}` })
const gallery = (n: string): Ref => ({ pack: 'dcl-gallery', sourceRef: `gallery/${n}` })
const interior = (n: string): Ref => ({ pack: 'dhingia-interiors', sourceRef: `Interior assets for builds/${n}.glb` })
const DJ = 'Dhingia Builds 14 Size 1x1 - DJ build & assets'
const dj = (n: string): Ref => ({ pack: 'dhingia-dj', sourceRef: `${DJ}/${n}.glb` })
const stage: Ref = { pack: 'dhingia-dj', sourceRef: 'Dhingia Builds 33 NFT Gallery or Club with SDK Size 1x1/Models/Stage.glb' }
const build = (dir: string, file: string): Ref => ({ pack: 'dhingia-buildings', sourceRef: `${dir}/${file}.glb` })

const at = (ref: Ref, x: number, z: number, rotationY = 0): ThemeItemRef => ({ ...ref, x, z, rotationY })

export const THEMES: Theme[] = [
  {
    id: 'little-park',
    name: 'Little park',
    items: [
      at(mini('Fountain_01'), 0.5, 0.62),
      at(mini('Bench_01'), 0.3, 0.42, 90),
      at(mini('Bench_01'), 0.7, 0.42, 270),
      at(mini('LampPost_01'), 0.35, 0.2),
      at(mini('LampPost_01'), 0.65, 0.2),
      at(mini('Pergola_01'), 0.5, 0.88),
      at(mini('TreeSycamore_03'), 0.1, 0.15),
      at(mini('TreeSycamore_01'), 0.9, 0.2),
      at(mini('TreePine_01'), 0.08, 0.6),
      at(mini('TreeRoundPine_02'), 0.92, 0.7),
      at(mini('TreeSycamore_02'), 0.15, 0.9),
      at(mini('Bush_01'), 0.25, 0.75),
      at(mini('Bush_02'), 0.78, 0.45),
      at(mini('TrashCan_01'), 0.72, 0.25),
    ],
  },
  {
    id: 'cozy-cafe',
    name: 'Cozy café',
    items: [
      at(mini('Store_03'), 0.5, 0.88, 180),
      at(mini('TableBar_01'), 0.28, 0.6),
      at(mini('TableBar_01'), 0.72, 0.6),
      at(mini('Chair_04'), 0.2, 0.6, 90),
      at(mini('Chair_04'), 0.36, 0.6, 270),
      at(mini('Chair_04'), 0.64, 0.6, 90),
      at(mini('Chair_04'), 0.8, 0.6, 270),
      at(mini('Sign_02'), 0.35, 0.2),
      at(mini('LampPost_03'), 0.12, 0.35),
      at(mini('LampPost_03'), 0.88, 0.35),
      at(mini('PlantPot_01'), 0.42, 0.82),
      at(mini('PlantPot_01'), 0.58, 0.82),
      at(mini('TreeSycamore_03'), 0.08, 0.9),
      at(mini('TreeSycamore_03'), 0.92, 0.9),
    ],
  },
  {
    id: 'gallery',
    name: 'Gallery',
    items: [
      at(gallery('floor_tile'), 0.5, 0.5),
      at(gallery('wall_plaingrey'), 0.5, 0.95),
      at(gallery('wall_plaingrey'), 0.1, 0.6, 90),
      at(gallery('wall_plaingrey'), 0.9, 0.6, 270),
      at(gallery('sofa_round'), 0.5, 0.55),
      at(gallery('pillar_two_coloured'), 0.3, 0.8),
      at(gallery('pillar_two_coloured'), 0.7, 0.8),
      at(gallery('armchair_white_modern'), 0.25, 0.4, 45),
      at(gallery('armchair_white_modern'), 0.75, 0.4, 315),
      at(gallery('artwork_info'), 0.3, 0.88),
      at(gallery('artwork_info'), 0.7, 0.88),
      at(mini('PlantPot_01'), 0.1, 0.1),
      at(mini('PlantPot_01'), 0.9, 0.1),
    ],
  },
  {
    id: 'beach-hangout',
    name: 'Beach hangout',
    items: [
      at(mini('FloorBaseSand_01'), 0.5, 0.5),
      at(mini('PalmTree_01'), 0.1, 0.2),
      at(mini('PalmTree_01'), 0.9, 0.35),
      at(mini('PalmTree_01'), 0.15, 0.85),
      at(mini('Umbrella_01'), 0.3, 0.55),
      at(mini('Couch_03'), 0.3, 0.45, 180),
      at(mini('Umbrella_01'), 0.7, 0.6),
      at(mini('Couch_03'), 0.7, 0.5, 180),
      at(mini('Boombox_01'), 0.5, 0.7),
      at(mini('Hammock_01'), 0.85, 0.8),
      at(mini('Barbacue_01'), 0.2, 0.75),
      at(mini('SurfBoard_01'), 0.08, 0.5, 90),
      at(mini('RockMedium_02'), 0.92, 0.1),
    ],
  },
  {
    id: 'stage-venue',
    name: 'Stage & venue',
    items: [
      at(stage, 0.5, 0.85, 180),
      at(dj('DJ booth asset'), 0.5, 0.7, 180),
      at(dj('Dance floor asset'), 0.5, 0.4),
      at(dj('Speaker asset'), 0.2, 0.8, 180),
      at(dj('Speaker asset'), 0.8, 0.8, 180),
      at(dj('Lazer Lights asset'), 0.5, 0.95, 180),
      at(dj('Vertical Lights asset'), 0.15, 0.6),
      at(dj('Vertical Lights asset'), 0.85, 0.6),
      at(mini('LampPost_03'), 0.12, 0.3),
      at(mini('LampPost_03'), 0.88, 0.3),
      at(mini('TreeTall_02'), 0.06, 0.1),
      at(mini('TreeTall_02'), 0.94, 0.1),
    ],
  },
  { id: 'empty', name: 'Empty plot', items: [] },
]

export const CATEGORY_CHIPS: CategoryChip[] = [
  {
    id: 'nature',
    label: 'Nature',
    categories: ['Plants & Nature'],
    picks: [
      'TreeSycamore_03', 'TreeSycamore_01', 'TreePine_01', 'TreeRoundPine_02', 'TreeTall_02', 'TreeFir_02',
      'PalmTree_01', 'Bush_01', 'Bush_02', 'BushPatch_01', 'Cactus_01', 'Flower_04', 'Flower_03', 'Plant_01',
      'PlantPot_01', 'Grass_01', 'RockLarge_01', 'RockMedium_02', 'Log_02', 'Pond_01', 'Mushroom_01',
      'GrassPatchLarge_01',
    ].map(mini),
  },
  {
    id: 'furniture',
    label: 'Furniture',
    categories: ['Furniture'],
    picks: [
      ...['Bench_01', 'Bench_02', 'Chair_04', 'Chair_07', 'Couch_01', 'Couch_03', 'Hammock_01', 'Table_01', 'Table_03', 'Table_06', 'TableBar_01'].map(mini),
      ...['Sofa 1 Big', 'Chair 1', 'Bed 1', 'Side Table 1 White', 'Table 1 V1', 'Seat'].map(interior),
      ...['armchair_white_modern', 'sofa_round', 'stool_modern'].map(gallery),
      fantasy('Shelf_02'),
    ],
  },
  {
    id: 'lighting',
    label: 'Lighting',
    categories: ['Lighting'],
    picks: [
      ...['Lamp 1 Long', 'Lamp 1 Small', 'Lamp 2'].map(interior),
      dj('Lazer Lights asset'),
      dj('Vertical Lights asset'),
      ...['Candle_02', 'Candle_04', 'Ceiling_Lamp_01', 'Chandelier_01', 'Torch_01'].map(fantasy),
      ...['ChineseLantern_01', 'ChineseLantern_03', 'ChineseLantern_04', 'ChineseLampPost_01'].map(chinese),
      ...['LampPostSciFi_01', 'NeonLightTube_03', 'NeonLightTube_04', 'NeonLight_01'].map(scifi),
    ],
  },
  {
    id: 'buildings',
    label: 'Buildings',
    categories: ['Building', 'Structure'],
    picks: [
      build('Dhingia Builds 01 Size 1x1', 'Dhingia Builds 01 Blue 1x1'),
      build('Dhingia Builds 02 Size 1x1', 'Dhingia Builds Blue 1x1'),
      build('Dhingia Builds 17 Size 1x1', 'Dhingia Builds 17 Blue Size 1x1'),
      build('Dhingia Builds 12 Size 2x2', 'Dhingia Builds 12 Size 2x2 Blue'),
      stage,
      ...['Store_03', 'Store_01', 'Store_02', 'Canopy_01', 'Pergola_01', 'Tent_01', 'Theatre_01', 'TreeHouse_01', 'Well_01', 'Bridge_01', 'Fountain_01', 'LampPost_01', 'FenceWoodMedium_01', 'FencePicketWhiteMedium_01', 'PetHouse_01'].map(mini),
      fantasy('ArchWay_02'),
    ],
  },
  {
    id: 'decor',
    label: 'Decor',
    categories: ['Decor', 'Signage'],
    picks: [
      ...['Carpet_03', 'Carpet_01', 'Umbrella_01', 'Umbrella_02', 'Trunk_01', 'MailPost_01', 'TrashCan_01', 'Terminal_01', 'Wheelbarrow_02', 'VegetablesBox_01', 'ConstructionPallet_01', 'Suitcase_01', 'Sign_01', 'Sign_02', 'Sign_03', 'Sign_04', 'ForSaleSign_01', 'DecentralandLogo_01'].map(mini),
      gallery('artwork_info'),
    ],
  },
]
