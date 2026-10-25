import { plotSizeM, type Plot } from 'vlm-shared'
import type { DclWorld, WizardAsset } from '../api'
import { budgetStatus, fitToBudget } from './budget'
import { clampToPlot, layoutTheme, suggestPosition, type PlacedItem } from './placement'

export type WizardStep = 'where' | 'size' | 'assets' | 'arrange' | 'deploy'

/** The 2×2 guide plot used for placement when there is no Decentraland destination. */
export const GUIDE_PLOT: Plot = { width: 2, depth: 2, base: { x: 0, y: 0 } }

export interface WizardState {
  step: WizardStep
  destinations: {
    dcl: { world: string; wallet: string; hasScene: boolean; footprint: DclWorld['footprint']; storage?: DclWorld['storage'] } | null
    hyperfy: null | { kind: 'self' | 'hosted'; name: string }
    ar: null | { name: string }
  }
  plot: Plot | null
  themeId: string | null
  items: PlacedItem[]
  spawn: { x: number; z: number }
  mode: 'virvi' | 'sign'
  name: string
  /** Items the last theme or plot change dropped to fit the budget. */
  lastDropped: number
  /** Plain-language message for the last action that could not happen. */
  notice: string | null
  /** Counter for item keys, so the reducer stays pure. */
  seq: number
}

export type WizardAction =
  | { type: 'setDcl'; dcl: WizardState['destinations']['dcl'] }
  | { type: 'setHyperfy'; hyperfy: WizardState['destinations']['hyperfy'] }
  | { type: 'setAr'; ar: WizardState['destinations']['ar'] }
  | { type: 'setPlot'; plot: Plot }
  | { type: 'applyTheme'; themeId: string | null; items: Array<{ asset: WizardAsset; x: number; z: number; rotationY: number }> }
  | { type: 'addAsset'; asset: WizardAsset }
  | { type: 'removeItem'; key: string }
  | { type: 'moveItem'; key: string; x: number; z: number }
  | { type: 'rotateItem'; key: string }
  | { type: 'moveSpawn'; x: number; z: number }
  | { type: 'setMode'; mode: 'virvi' | 'sign' }
  | { type: 'setName'; name: string }
  | { type: 'goTo'; step: WizardStep }

/** Default arrival point: centre along x, 1 m in from the south edge (matches the server). */
export function defaultSpawn(plot: Plot): { x: number; z: number } {
  return { x: plotSizeM(plot).x / 2, z: 1 }
}

export const initialState: WizardState = {
  step: 'where',
  destinations: { dcl: null, hyperfy: null, ar: null },
  plot: null,
  themeId: null,
  items: [],
  spawn: defaultSpawn(GUIDE_PLOT),
  mode: 'virvi',
  name: '',
  lastDropped: 0,
  notice: null,
  seq: 0,
}

/** The plot used for placement: the chosen one, else the guide plot. */
export function effectivePlot(state: WizardState): Plot {
  return state.plot ?? GUIDE_PLOT
}

/** Budget for the current items; hard limits apply only with a Decentraland destination. */
export function stateBudget(state: WizardState, items = state.items) {
  const dcl = state.destinations.dcl
  return budgetStatus(items, dcl ? state.plot : null, dcl?.storage ?? null)
}

function clampSpawn(plot: Plot, s: { x: number; z: number }) {
  const size = plotSizeM(plot)
  return { x: Math.min(size.x, Math.max(0, s.x)), z: Math.min(size.z, Math.max(0, s.z)) }
}

/** Decentraland limits apply only with a dcl destination and a chosen plot; otherwise every item stays. */
function fitIfLimited(state: WizardState, items: PlacedItem[], plot: Plot | null) {
  return state.destinations.dcl && plot ? fitToBudget(items, plot) : { items, dropped: 0 }
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'setDcl':
      return { ...state, destinations: { ...state.destinations, dcl: action.dcl }, notice: null }
    case 'setHyperfy':
      return { ...state, destinations: { ...state.destinations, hyperfy: action.hyperfy }, notice: null }
    case 'setAr':
      return { ...state, destinations: { ...state.destinations, ar: action.ar }, notice: null }
    case 'setPlot': {
      const plot = action.plot
      const clamped = state.items.map((i) => clampToPlot(plot, i))
      const fit = fitIfLimited(state, clamped, plot)
      const old = effectivePlot(state)
      const wasDefault = state.spawn.x === defaultSpawn(old).x && state.spawn.z === defaultSpawn(old).z
      return {
        ...state,
        plot,
        items: fit.items,
        lastDropped: fit.dropped,
        spawn: wasDefault ? defaultSpawn(plot) : clampSpawn(plot, state.spawn),
        notice: null,
      }
    }
    case 'applyTheme': {
      const plot = effectivePlot(state)
      const fit = fitIfLimited(state, layoutTheme(action.items, plot), state.plot)
      return { ...state, themeId: action.themeId, items: fit.items, lastDropped: fit.dropped, seq: state.seq + fit.items.length, notice: null }
    }
    case 'addAsset': {
      const plot = effectivePlot(state)
      const pos = suggestPosition(plot, state.items, action.asset, state.spawn)
      if (!pos) return { ...state, notice: `There is no free room left on the plot for ${action.asset.name}` }
      const item: PlacedItem = { key: `item-${state.seq}`, asset: action.asset, x: pos.x, z: pos.z, rotationY: 0 }
      const items = [...state.items, item]
      const over = stateBudget(state, items).over
      if (over) return { ...state, notice: over }
      return { ...state, items, seq: state.seq + 1, lastDropped: 0, notice: null }
    }
    case 'removeItem':
      return { ...state, items: state.items.filter((i) => i.key !== action.key), notice: null }
    case 'moveItem':
      return {
        ...state,
        items: state.items.map((i) => (i.key === action.key ? clampToPlot(effectivePlot(state), { ...i, x: action.x, z: action.z }) : i)),
      }
    case 'rotateItem':
      return {
        ...state,
        items: state.items.map((i) =>
          i.key === action.key ? clampToPlot(effectivePlot(state), { ...i, rotationY: (i.rotationY + 90) % 360 }) : i,
        ),
      }
    case 'moveSpawn':
      return { ...state, spawn: clampSpawn(effectivePlot(state), { x: action.x, z: action.z }) }
    case 'setMode':
      return { ...state, mode: action.mode }
    case 'setName':
      return { ...state, name: action.name }
    case 'goTo':
      return { ...state, step: action.step, notice: null }
  }
}

export function canAdvance(state: WizardState): boolean {
  const { dcl, hyperfy, ar } = state.destinations
  switch (state.step) {
    case 'where':
      return !!(dcl || hyperfy || ar)
    case 'size':
      return dcl ? state.plot !== null : true
    case 'assets':
    case 'arrange':
      return stateBudget(state).over === null
    case 'deploy':
      return false
  }
}
