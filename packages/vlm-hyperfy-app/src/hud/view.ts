/**
 * Draws the HUD view model as Hyperfy screen UI (`ui`, `uiview`, `uitext`, `uiimage`). No logic: every button
 * calls one HudActions method. Three screen canvases: the bar (top centre), the open panel (right) and the alert
 * stack (bottom centre, click-through). Screen UI takes clicks only while the pointer is unlocked.
 */
import type { TransformMode } from 'vlm-core/transform/session'
import type { AssetTab, Axis, HudViewModel, Panel } from './model.js'

export interface UiNode {
  add(child: UiNode): void
  remove(child: UiNode): void
  children?: UiNode[]
  height?: number
  onPointerDown?: () => void
  [prop: string]: unknown
}

export interface UiHost {
  create(type: 'ui' | 'uiview' | 'uitext' | 'uiimage', data?: Record<string, unknown>): UiNode
  add(node: UiNode): void
  remove(node: UiNode): void
}

export interface HudActions {
  link(): void
  openUrl(url: string): void
  toggleEditing(): void
  setMode(mode: TransformMode): void
  cycleLock(): void
  toggleSnap(): void
  save(): void
  revert(): void
  done(): void
  typeAxis(axis: Axis): void
  openPanel(panel: Exclude<Panel, null>): void
  toggleEnabled(elementId: string, enabled: boolean): void
  setPreset(presetId: string): void
  toggleLive(elementId: string, on: boolean): void
  setTab(tab: AssetTab): void
  choose(id: string): void
  typeField(field: 'link' | 'search'): void
  place(): void
}

const C = {
  bg: 'rgba(15, 17, 26, 0.88)',
  button: 'rgba(255, 255, 255, 0.12)',
  on: '#6e56cf',
  text: '#ffffff',
  dim: 'rgba(255, 255, 255, 0.6)',
  error: '#e5484d',
  info: '#46a758',
}
const ROW = 34
const MODES: Array<[TransformMode, string]> = [
  ['move', 'Move'],
  ['rotate', 'Rotate'],
  ['resize', 'Resize'],
]
const PANELS: Array<[Exclude<Panel, null>, string]> = [
  ['layout', 'Scene layout'],
  ['streams', 'Streams'],
  ['assets', 'Assets'],
]
const TAB_LABEL: Record<AssetTab, string> = { library: 'Library', catalog: 'Catalog', link: 'Link' }

export class HudView {
  private readonly bar: UiNode
  private readonly panel: UiNode
  private readonly alerts: UiNode
  private shown = false
  /** The last full render's layout (see `valuesless`) and its value labels, in axis order. */
  private layout = ''
  private valueLabels: UiNode[] = []
  private lastLabel: UiNode | null = null

  constructor(
    private readonly host: UiHost,
    private readonly act: HudActions,
  ) {
    const base = {
      space: 'screen',
      backgroundColor: C.bg,
      borderRadius: 10,
      padding: 10,
      gap: 6,
      flexDirection: 'column',
    }
    this.bar = host.create('ui', {
      ...base,
      pivot: 'top-center',
      position: [0.5, 0, 0],
      offset: [0, 16, 0],
      width: 720,
      height: 100,
    })
    this.panel = host.create('ui', {
      ...base,
      pivot: 'top-right',
      position: [1, 0, 0],
      offset: [-16, 16, 0],
      width: 340,
      height: 100,
    })
    this.alerts = host.create('ui', {
      ...base,
      backgroundColor: null,
      pointerEvents: false,
      pivot: 'bottom-center',
      position: [0.5, 1, 0],
      offset: [0, -80, 0],
      width: 520,
      height: 3 * ROW + 20,
      justifyContent: 'flex-end',
    })
  }

  /** Draws the model, or removes the HUD for null (a visitor who is neither admin nor builder). */
  render(vm: HudViewModel | null): void {
    if (!vm) return this.hide()
    // A drag changes only the values: retext those labels instead of rebuilding every node each frame.
    const layout = valuesless(vm)
    const values = vm.bar?.values
    if (
      this.shown &&
      layout === this.layout &&
      values &&
      values.length === this.valueLabels.length
    ) {
      values.forEach((v, i) => (this.valueLabels[i].value = valueText(v)))
      return
    }
    this.layout = layout
    this.valueLabels = []
    this.fill(this.bar, this.barRows(vm))
    const panelRows = this.panelRows(vm)
    this.fill(this.panel, panelRows)
    this.fill(
      this.alerts,
      vm.alerts.map((a) =>
        this.row([this.label(a.text, a.kind === 'error' ? C.error : C.info, 15, true)]),
      ),
    )
    this.attach(this.bar, true)
    this.attach(this.panel, panelRows.length > 0)
    this.attach(this.alerts, vm.alerts.length > 0)
    this.shown = true
  }

  hide(): void {
    if (!this.shown) return
    for (const n of [this.bar, this.panel, this.alerts]) this.attach(n, false)
    this.shown = false
  }

  private readonly attached = new Set<UiNode>()
  private attach(n: UiNode, on: boolean): void {
    if (on && !this.attached.has(n)) {
      this.host.add(n)
      this.attached.add(n)
    } else if (!on && this.attached.has(n)) {
      this.host.remove(n)
      this.attached.delete(n)
    }
  }

  private fill(root: UiNode, rows: UiNode[]): void {
    for (const c of [...(root.children ?? [])]) root.remove(c)
    for (const r of rows) root.add(r)
    root.height = 20 + rows.reduce((h, r) => h + (this.heights.get(r) ?? ROW) + 6, 0)
    this.heights.clear()
  }

  /** Row heights of the rows being built (for sizing the canvas; Hyperfy screen UI has a fixed size). */
  private readonly heights = new Map<UiNode, number>()

  // ── rows ─────────────────────────────────────────────────────────────

  private barRows(vm: HudViewModel): UiNode[] {
    const a = this.act
    const l = vm.link
    if (!vm.bar) {
      const rows = [
        this.row([
          this.label('VLM', C.dim),
          l.canLink ? this.button(l.label, () => a.link()) : this.label(l.label),
        ]),
      ]
      if (l.code) {
        rows.push(this.row([this.label(l.code, C.text, 28, true)], 40))
        if (l.qrUrl) rows.push(this.row([this.image(l.qrUrl, 140)], 140))
        if (l.approveUrl)
          rows.push(
            this.row([this.button('Open the approve page', () => a.openUrl(l.approveUrl!))]),
          )
      }
      return rows
    }
    const b = vm.bar
    const relink = vm.linked
      ? []
      : [
          this.row([
            this.label(l.label, C.error),
            ...(l.canLink ? [this.button('Link to VLM', () => a.link())] : []),
          ]),
        ]
    const rows: UiNode[] = [
      ...relink,
      this.row([
        this.label('VLM', C.dim),
        this.button(b.editing ? 'Editing' : 'Edit', () => a.toggleEditing(), b.editing),
        ...PANELS.map(([p, text]) => this.button(text, () => a.openPanel(p), vm.panel === p)),
      ]),
    ]
    if (!b.editing) return rows
    rows.push(
      this.row([
        ...MODES.map(([m, text]) => this.button(text, () => a.setMode(m), b.mode === m)),
        this.button(`Lock: ${b.lockLabel}`, () => a.cycleLock(), b.lock !== 'free'),
        this.button('Snap', () => a.toggleSnap(), b.snap),
        this.button(b.saving ? 'Saving…' : 'Save', () => a.save(), b.dirty),
        this.button('Revert', () => a.revert()),
        this.button('Done', () => a.done()),
      ]),
    )
    const sel =
      b.selectedName === null
        ? 'Click a VLM object to select it'
        : `${b.selectedName || 'Untitled'}${b.dirty ? ' •' : ''}`
    rows.push(
      this.row([
        this.label(sel),
        ...(b.values ?? []).map((v) => {
          const n = this.button(valueText(v), () => a.typeAxis(v.axis), v.typing)
          this.valueLabels.push(this.lastLabel!)
          return n
        }),
      ]),
    )
    if (b.prompt) rows.push(this.row([this.label('Unsaved changes: Save or Revert', C.error)]))
    rows.push(this.row([this.label(b.hint, C.dim, 12)], 20))
    return rows
  }

  private panelRows(vm: HudViewModel): UiNode[] {
    const a = this.act
    switch (vm.panel) {
      case 'layout':
        return [
          this.row([this.label('Presets', C.dim)]),
          ...vm.layout.presets.map((p) =>
            this.row([this.button(p.name, () => a.setPreset(p.id), p.active)]),
          ),
          this.row([this.label('Objects', C.dim)]),
          ...vm.layout.items.map((i) =>
            this.row([
              this.label(i.name),
              this.button(
                i.enabled ? 'Shown' : 'Hidden',
                () => a.toggleEnabled(i.elementId, !i.enabled),
                i.enabled,
              ),
            ]),
          ),
        ]
      case 'streams':
        return vm.streams.length
          ? vm.streams.map((s) =>
              this.row([
                this.label(`${s.name}${s.isLive ? ' (live)' : ''}`),
                this.button(
                  s.enableLiveStream ? 'Go offline' : 'Go live',
                  () => a.toggleLive(s.elementId, !s.enableLiveStream),
                  s.enableLiveStream,
                ),
              ]),
            )
          : [this.row([this.label('No screens in this preset', C.dim)])]
      case 'assets': {
        const s = vm.assets
        const rows = [
          this.row(s.tabs.map((t) => this.button(TAB_LABEL[t], () => a.setTab(t), s.tab === t))),
        ]
        if (s.tab === 'link') {
          rows.push(
            this.row([
              this.button(
                s.typing === 'link' ? `${s.linkUrl}_` : s.linkUrl || 'Type a GLB link',
                () => a.typeField('link'),
                s.typing === 'link',
              ),
            ]),
          )
        } else {
          if (s.tab === 'catalog')
            rows.push(
              this.row([
                this.button(
                  s.typing === 'search' ? `${s.query}_` : s.query || 'Search the catalog',
                  () => a.typeField('search'),
                  s.typing === 'search',
                ),
              ]),
            )
          if (s.loading) rows.push(this.row([this.label('Loading…', C.dim)]))
          else if (!s.entries.length) rows.push(this.row([this.label('Nothing here yet', C.dim)]))
          for (const e of s.entries)
            rows.push(this.row([this.button(e.name, () => a.choose(e.id), e.chosen)]))
        }
        if (s.canPlace) rows.push(this.row([this.button(s.placeLabel, () => a.place(), true)]))
        return rows
      }
      default:
        return []
    }
  }

  // ── nodes ────────────────────────────────────────────────────────────

  private row(children: UiNode[], height = ROW): UiNode {
    const n = this.host.create('uiview', {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      height,
    })
    this.heights.set(n, height)
    for (const c of children) n.add(c)
    return n
  }

  private label(value: string, color = C.text, fontSize = 14, bold = false): UiNode {
    return this.host.create('uitext', {
      value,
      color,
      fontSize,
      fontWeight: bold ? 'bold' : 'normal',
    })
  }

  private image(src: string, size: number): UiNode {
    return this.host.create('uiimage', {
      src,
      width: size,
      height: size,
      objectFit: 'contain',
      backgroundColor: '#ffffff',
    })
  }

  private button(text: string, onPress: () => void, on = false): UiNode {
    const n = this.host.create('uiview', {
      backgroundColor: on ? C.on : C.button,
      borderRadius: 6,
      padding: 6,
      cursor: 'pointer',
    })
    n.onPointerDown = onPress
    this.lastLabel = this.label(text)
    n.add(this.lastLabel)
    return n
  }
}

type Value = NonNullable<NonNullable<HudViewModel['bar']>['values']>[number]
const valueText = (v: Value) => `${v.axis.toUpperCase()} ${v.text}`
/** The view model without the value texts: equal when only a drag's values changed. */
const valuesless = (vm: HudViewModel) =>
  JSON.stringify({
    ...vm,
    bar: vm.bar && { ...vm.bar, values: vm.bar.values?.map((v) => [v.axis, v.typing]) ?? null },
  })
