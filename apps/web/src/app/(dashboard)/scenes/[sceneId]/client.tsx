'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useSceneRoom } from '@/lib/colyseus'
import { useParams, useSearchParams } from 'next/navigation'
import { useEffect, useState, useCallback, useRef } from 'react'


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ElementType = 'video' | 'image' | 'sound' | 'model' | 'widget'
type TabKey = ElementType | 'moderation'

interface Instance {
  id: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  enabled: boolean
}

interface Element {
  id: string
  type: ElementType
  name: string
  enabled: boolean
  properties: Record<string, any>
  instances: Instance[]
}

interface Preset {
  id: string
  name: string
  elements: Element[]
}

interface Scene {
  id: string
  name: string
  presets: Preset[]
}

// ---------------------------------------------------------------------------
// Tab config
// ---------------------------------------------------------------------------

const TABS: { key: TabKey; label: string }[] = [
  { key: 'video', label: 'Videos' },
  { key: 'image', label: 'Images' },
  { key: 'model', label: 'Models' },
  { key: 'sound', label: 'Sounds' },
  { key: 'widget', label: 'Widgets' },
  { key: 'moderation', label: 'Moderation' },
]

const CONTROL_TYPES = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Toggle' },
  { value: 2, label: 'Text' },
  { value: 3, label: 'Selector' },
  { value: 4, label: 'DateTime' },
  { value: 5, label: 'Trigger' },
  { value: 6, label: 'Slider' },
]

const OFF_TYPES = ['None', 'Image', 'Playlist']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function NumberInput({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [local, setLocal] = useState(String(value))
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { setLocal(String(value)) }, [value])

  const commit = () => {
    const n = parseFloat(local)
    if (!isNaN(n) && n !== value) onChange(n)
    else setLocal(String(value))
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-gray-500">{label}</span>
      <input ref={ref} type="number" step="any" value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') ref.current?.blur() }}
        className="w-20 rounded bg-gray-800 px-2 py-1 text-sm text-white outline-none focus:ring-1 focus:ring-blue-500" />
    </div>
  )
}

function TextInput({ value, onChange, label, readOnly }: { value: string; onChange: (v: string) => void; label: string; readOnly?: boolean }) {
  const [local, setLocal] = useState(value)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { setLocal(value) }, [value])

  const commit = () => {
    if (local !== value) onChange(local)
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-gray-500">{label}</span>
      <input ref={ref} type="text" value={local} readOnly={readOnly}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') ref.current?.blur() }}
        className={`w-full rounded bg-gray-800 px-3 py-1.5 text-sm text-white outline-none focus:ring-1 focus:ring-blue-500 ${readOnly ? 'opacity-60 cursor-not-allowed' : ''}`} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Instance Editor
// ---------------------------------------------------------------------------

function InstanceEditor({ instance, onUpdate, onDelete }: { instance: Instance; onUpdate: (data: Partial<Instance>) => void; onDelete: () => void }) {
  const updatePos = (axis: 'x' | 'y' | 'z', v: number) => {
    onUpdate({ position: { ...instance.position, [axis]: v } })
  }
  const updateRot = (axis: 'x' | 'y' | 'z', v: number) => {
    onUpdate({ rotation: { ...instance.rotation, [axis]: v } })
  }
  const updateScale = (axis: 'x' | 'y' | 'z', v: number) => {
    onUpdate({ scale: { ...instance.scale, [axis]: v } })
  }

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-500">Instance {instance.id.slice(0, 8)}</span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-400">
            <input type="checkbox" checked={instance.enabled}
              onChange={e => onUpdate({ enabled: e.target.checked })}
              className="accent-blue-500" />
            Enabled
          </label>
          <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-300">Delete</button>
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1">Position</p>
        <div className="flex gap-2">
          <NumberInput label="X" value={instance.position.x} onChange={v => updatePos('x', v)} />
          <NumberInput label="Y" value={instance.position.y} onChange={v => updatePos('y', v)} />
          <NumberInput label="Z" value={instance.position.z} onChange={v => updatePos('z', v)} />
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1">Rotation</p>
        <div className="flex gap-2">
          <NumberInput label="X" value={instance.rotation.x} onChange={v => updateRot('x', v)} />
          <NumberInput label="Y" value={instance.rotation.y} onChange={v => updateRot('y', v)} />
          <NumberInput label="Z" value={instance.rotation.z} onChange={v => updateRot('z', v)} />
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1">Scale</p>
        <div className="flex gap-2">
          <NumberInput label="X" value={instance.scale.x} onChange={v => updateScale('x', v)} />
          <NumberInput label="Y" value={instance.scale.y} onChange={v => updateScale('y', v)} />
          <NumberInput label="Z" value={instance.scale.z} onChange={v => updateScale('z', v)} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Video Element Editor
// ---------------------------------------------------------------------------

function VideoElementEditor({ element, onUpdateElement, onUpdateInstance, onDeleteInstance, onAddInstance }: {
  element: Element
  onUpdateElement: (id: string, data: Record<string, any>) => void
  onUpdateInstance: (id: string, data: Partial<Instance>) => void
  onDeleteInstance: (id: string) => void
  onAddInstance: (elementId: string) => void
}) {
  const props = element.properties || {}

  const updateProp = (key: string, value: any) => {
    onUpdateElement(element.id, { properties: { ...props, [key]: value } })
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{element.name}</h4>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={element.enabled}
            onChange={e => onUpdateElement(element.id, { enabled: e.target.checked })}
            className="accent-blue-500" />
          Enabled
        </label>
      </div>

      <TextInput label="Live Stream URL" value={props.liveSrc || ''} onChange={v => updateProp('liveSrc', v)} />

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className={`inline-block h-2 w-2 rounded-full ${props.isLive ? 'bg-green-400' : 'bg-gray-600'}`} />
          <span className="text-gray-400">{props.isLive ? 'Live' : 'Offline'}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Off Type</span>
        <select value={props.offType ?? 0}
          onChange={e => updateProp('offType', parseInt(e.target.value))}
          className="w-48 rounded bg-gray-800 px-3 py-1.5 text-sm text-white outline-none focus:ring-1 focus:ring-blue-500">
          {OFF_TYPES.map((label, i) => (
            <option key={i} value={i}>{label}</option>
          ))}
        </select>
      </div>

      {(props.offType === 1) && (
        <TextInput label="Off Image URL" value={props.offImageSrc || ''} onChange={v => updateProp('offImageSrc', v)} />
      )}

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Volume</span>
        <div className="flex items-center gap-3">
          <input type="range" min={0} max={1} step={0.01} value={props.volume ?? 1}
            onChange={e => updateProp('volume', parseFloat(e.target.value))}
            className="flex-1 accent-blue-500" />
          <span className="text-sm text-gray-400 w-10 text-right">{Math.round((props.volume ?? 1) * 100)}%</span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">Instances ({element.instances.length})</p>
          <button onClick={() => onAddInstance(element.id)} className="text-xs text-blue-400 hover:text-blue-300">+ Add Instance</button>
        </div>
        {element.instances.map(inst => (
          <InstanceEditor key={inst.id} instance={inst}
            onUpdate={data => onUpdateInstance(inst.id, data)}
            onDelete={() => onDeleteInstance(inst.id)} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Image Element Editor
// ---------------------------------------------------------------------------

function ImageElementEditor({ element, onUpdateElement, onUpdateInstance, onDeleteInstance, onAddInstance }: {
  element: Element
  onUpdateElement: (id: string, data: Record<string, any>) => void
  onUpdateInstance: (id: string, data: Partial<Instance>) => void
  onDeleteInstance: (id: string) => void
  onAddInstance: (elementId: string) => void
}) {
  const props = element.properties || {}

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{element.name}</h4>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={element.enabled}
            onChange={e => onUpdateElement(element.id, { enabled: e.target.checked })}
            className="accent-blue-500" />
          Enabled
        </label>
      </div>

      <TextInput label="Texture URL" value={props.textureSrc || ''}
        onChange={v => onUpdateElement(element.id, { properties: { ...props, textureSrc: v } })} />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">Instances ({element.instances.length})</p>
          <button onClick={() => onAddInstance(element.id)} className="text-xs text-blue-400 hover:text-blue-300">+ Add Instance</button>
        </div>
        {element.instances.map(inst => (
          <InstanceEditor key={inst.id} instance={inst}
            onUpdate={data => onUpdateInstance(inst.id, data)}
            onDelete={() => onDeleteInstance(inst.id)} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model Element Editor
// ---------------------------------------------------------------------------

function ModelElementEditor({ element, onUpdateElement, onUpdateInstance, onDeleteInstance, onAddInstance }: {
  element: Element
  onUpdateElement: (id: string, data: Record<string, any>) => void
  onUpdateInstance: (id: string, data: Partial<Instance>) => void
  onDeleteInstance: (id: string) => void
  onAddInstance: (elementId: string) => void
}) {
  const props = element.properties || {}

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{element.name}</h4>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={element.enabled}
            onChange={e => onUpdateElement(element.id, { enabled: e.target.checked })}
            className="accent-blue-500" />
          Enabled
        </label>
      </div>

      <TextInput label="Model URL" value={props.modelSrc || ''}
        onChange={v => onUpdateElement(element.id, { properties: { ...props, modelSrc: v } })} />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">Instances ({element.instances.length})</p>
          <button onClick={() => onAddInstance(element.id)} className="text-xs text-blue-400 hover:text-blue-300">+ Add Instance</button>
        </div>
        {element.instances.map(inst => (
          <InstanceEditor key={inst.id} instance={inst}
            onUpdate={data => onUpdateInstance(inst.id, data)}
            onDelete={() => onDeleteInstance(inst.id)} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sound Element Editor
// ---------------------------------------------------------------------------

function SoundElementEditor({ element, onUpdateElement, onUpdateInstance, onDeleteInstance, onAddInstance }: {
  element: Element
  onUpdateElement: (id: string, data: Record<string, any>) => void
  onUpdateInstance: (id: string, data: Partial<Instance>) => void
  onDeleteInstance: (id: string) => void
  onAddInstance: (elementId: string) => void
}) {
  const props = element.properties || {}

  const updateProp = (key: string, value: any) => {
    onUpdateElement(element.id, { properties: { ...props, [key]: value } })
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{element.name}</h4>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={element.enabled}
            onChange={e => onUpdateElement(element.id, { enabled: e.target.checked })}
            className="accent-blue-500" />
          Enabled
        </label>
      </div>

      <TextInput label="Audio URL" value={props.audioSrc || ''} onChange={v => updateProp('audioSrc', v)} />

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Volume</span>
        <div className="flex items-center gap-3">
          <input type="range" min={0} max={1} step={0.01} value={props.volume ?? 1}
            onChange={e => updateProp('volume', parseFloat(e.target.value))}
            className="flex-1 accent-blue-500" />
          <span className="text-sm text-gray-400 w-10 text-right">{Math.round((props.volume ?? 1) * 100)}%</span>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-400">
        <input type="checkbox" checked={props.loop ?? false}
          onChange={e => updateProp('loop', e.target.checked)}
          className="accent-blue-500" />
        Loop
      </label>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">Instances ({element.instances.length})</p>
          <button onClick={() => onAddInstance(element.id)} className="text-xs text-blue-400 hover:text-blue-300">+ Add Instance</button>
        </div>
        {element.instances.map(inst => (
          <InstanceEditor key={inst.id} instance={inst}
            onUpdate={data => onUpdateInstance(inst.id, data)}
            onDelete={() => onDeleteInstance(inst.id)} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Widget Value Editor (renders appropriate input based on controlType)
// ---------------------------------------------------------------------------

function WidgetValueEditor({ controlType, value, onChange }: { controlType: number; value: any; onChange: (v: any) => void }) {
  switch (controlType) {
    case 1: // Toggle
      return (
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} className="accent-blue-500" />
          {value ? 'On' : 'Off'}
        </label>
      )
    case 2: // Text
      return <TextInput label="Value" value={value || ''} onChange={onChange} />
    case 3: // Selector
      return <TextInput label="Options (comma-separated)" value={value || ''} onChange={onChange} />
    case 4: // DateTime
      return (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Date/Time</span>
          <input type="datetime-local" value={value || ''}
            onChange={e => onChange(e.target.value)}
            className="w-64 rounded bg-gray-800 px-3 py-1.5 text-sm text-white outline-none focus:ring-1 focus:ring-blue-500" />
        </div>
      )
    case 5: // Trigger
      return (
        <button onClick={() => onChange(true)}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors">
          Trigger
        </button>
      )
    case 6: // Slider
      return (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Value: {value ?? 50}</span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">0</span>
            <input type="range" min={0} max={100} step={1} value={value ?? 50}
              onChange={e => onChange(parseInt(e.target.value))}
              className="flex-1 accent-blue-500" />
            <span className="text-xs text-gray-500">100</span>
          </div>
        </div>
      )
    default: // None
      return <span className="text-xs text-gray-500 italic">No control</span>
  }
}

// ---------------------------------------------------------------------------
// Widget Element Editor
// ---------------------------------------------------------------------------

function WidgetElementEditor({ element, onUpdateElement, onDelete }: {
  element: Element
  onUpdateElement: (id: string, data: Record<string, any>) => void
  onDelete: (id: string) => void
}) {
  const props = element.properties || {}

  const updateProp = (key: string, value: any) => {
    onUpdateElement(element.id, { properties: { ...props, [key]: value } })
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{element.name}</h4>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input type="checkbox" checked={element.enabled}
              onChange={e => onUpdateElement(element.id, { enabled: e.target.checked })}
              className="accent-blue-500" />
            Enabled
          </label>
          <button onClick={() => onDelete(element.id)} className="text-xs text-red-400 hover:text-red-300">Delete</button>
        </div>
      </div>

      <TextInput label="Name" value={element.name} onChange={v => onUpdateElement(element.id, { name: v })} />

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Control Type</span>
        <select value={props.controlType ?? 0}
          onChange={e => updateProp('controlType', parseInt(e.target.value))}
          className="w-48 rounded bg-gray-800 px-3 py-1.5 text-sm text-white outline-none focus:ring-1 focus:ring-blue-500">
          {CONTROL_TYPES.map(ct => (
            <option key={ct.value} value={ct.value}>{ct.label}</option>
          ))}
        </select>
      </div>

      <WidgetValueEditor controlType={props.controlType ?? 0} value={props.value} onChange={v => updateProp('value', v)} />

      <NumberInput label="Display Order" value={props.order ?? 0} onChange={v => updateProp('order', v)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Moderation Panel
// ---------------------------------------------------------------------------

interface ModerationAction {
  id: string
  type: string
  detail: string
  timestamp: Date
}

function ModerationPanel({ sendMessage }: { sendMessage: (type: string, payload: any) => void }) {
  const [msgText, setMsgText] = useState('')
  const [msgColor, setMsgColor] = useState('#ffffff')
  const [msgFontSize, setMsgFontSize] = useState(16)
  const [msgDelay, setMsgDelay] = useState(5000)
  const [crashTarget, setCrashTarget] = useState('')
  const [actions, setActions] = useState<ModerationAction[]>([])

  const addAction = (type: string, detail: string) => {
    setActions(prev => [{ id: crypto.randomUUID(), type, detail, timestamp: new Date() }, ...prev].slice(0, 50))
  }

  const handleSendMessage = () => {
    if (!msgText.trim()) return
    sendMessage('scene_moderator_message', {
      message: msgText,
      color: msgColor,
      fontSize: msgFontSize,
      delay: msgDelay,
    })
    addAction('Message', msgText)
    setMsgText('')
  }

  const handleCrashUser = () => {
    if (!crashTarget.trim()) return
    sendMessage('scene_moderator_crash', { connectedWallet: crashTarget })
    addAction('Crash', crashTarget)
    setCrashTarget('')
  }

  return (
    <div className="space-y-6">
      {/* Send Message */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
        <h4 className="font-semibold">Send Message</h4>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Message Text</span>
          <textarea value={msgText} onChange={e => setMsgText(e.target.value)}
            placeholder="Type a message to display in-world..."
            className="w-full rounded bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-blue-500 resize-y min-h-[60px]" />
        </div>
        <div className="flex items-end gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Color</span>
            <input type="color" value={msgColor} onChange={e => setMsgColor(e.target.value)}
              className="h-8 w-12 rounded bg-gray-800 border border-gray-700 cursor-pointer" />
          </div>
          <NumberInput label="Font Size" value={msgFontSize} onChange={setMsgFontSize} />
          <NumberInput label="Delay (ms)" value={msgDelay} onChange={setMsgDelay} />
          <button onClick={handleSendMessage}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
            disabled={!msgText.trim()}>
            Send
          </button>
        </div>
      </div>

      {/* Crash User */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
        <h4 className="font-semibold">Crash User</h4>
        <div className="flex items-end gap-4">
          <div className="flex-1">
            <TextInput label="Wallet / User ID" value={crashTarget} onChange={setCrashTarget} />
          </div>
          <button onClick={handleCrashUser}
            className="rounded bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-500 transition-colors disabled:opacity-50"
            disabled={!crashTarget.trim()}>
            Crash
          </button>
        </div>
      </div>

      {/* Recent Actions */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
        <h4 className="font-semibold">Recent Actions</h4>
        {actions.length === 0 ? (
          <p className="text-gray-500 text-sm">No moderation actions yet.</p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {actions.map(action => (
              <div key={action.id} className="flex items-center gap-3 text-sm border-b border-gray-800 pb-2">
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  action.type === 'Message' ? 'bg-blue-900/50 text-blue-400' : 'bg-red-900/50 text-red-400'
                }`}>
                  {action.type}
                </span>
                <span className="text-gray-400 truncate flex-1">{action.detail}</span>
                <span className="text-xs text-gray-600 whitespace-nowrap">{action.timestamp.toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Scene Editor Page
// ---------------------------------------------------------------------------

export default function SceneEditorPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const sceneId = (searchParams.get('id') || params.sceneId) as string
  const { token } = useAuth()
  const api = useApi()
  const { room, connected, sendUpdate, sendMessage } = useSceneRoom(sceneId, token)

  const [scene, setScene] = useState<Scene | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<TabKey>('video')
  const [copied, setCopied] = useState(false)

  // -----------------------------------------------------------------------
  // Load scene
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!token || !sceneId || sceneId === '_') return
    api.getScene(sceneId)
      .then(data => { setScene(data.scene); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [token, sceneId])

  // -----------------------------------------------------------------------
  // Listen for Colyseus broadcasts
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!room) return

    const handler = (message: any) => {
      // Update local state based on incoming broadcast
      setScene(prev => {
        if (!prev) return prev
        return applyRemoteUpdate(prev, message)
      })
    }

    room.onMessage('scene_preset_update', handler)

    return () => {
      // Colyseus SDK does not have a removeListener for onMessage in all versions,
      // but the room cleanup on unmount handles this via the parent useEffect.
    }
  }, [room])

  // -----------------------------------------------------------------------
  // Apply remote update to local scene state
  // -----------------------------------------------------------------------

  const applyRemoteUpdate = useCallback((scene: Scene, message: any): Scene => {
    const { action, element: elType, elementData, instanceData } = message

    return {
      ...scene,
      presets: scene.presets.map(preset => ({
        ...preset,
        elements: preset.elements.map(el => {
          // Match element update
          if (action === 'update' && elementData && el.id === elementData.id) {
            return {
              ...el,
              ...elementData,
              properties: { ...el.properties, ...(elementData.properties || {}) },
              instances: el.instances, // keep instances unless explicitly included
            }
          }

          // Match instance update
          if (instanceData && el.instances.some(i => i.id === instanceData.id)) {
            return {
              ...el,
              instances: el.instances.map(inst =>
                inst.id === instanceData.id ? { ...inst, ...instanceData } : inst
              ),
            }
          }

          return el
        }),
      })),
    }
  }, [])

  // -----------------------------------------------------------------------
  // Get active preset elements
  // -----------------------------------------------------------------------

  const activePreset = scene?.presets?.[0] // Use first preset as active for now
  const elements = activePreset?.elements || []
  const filteredElements = activeTab === 'moderation' ? [] : elements.filter(el => el.type === activeTab)

  // -----------------------------------------------------------------------
  // Update handlers
  // -----------------------------------------------------------------------

  const handleUpdateElement = useCallback(async (elementId: string, data: Record<string, any>) => {
    try {
      await api.updateElement(elementId, data)

      // Broadcast via Colyseus
      const el = elements.find(e => e.id === elementId)
      if (el) {
        sendUpdate({
          action: 'update',
          element: el.type,
          elementData: { id: elementId, ...data },
        })
      }

      // Update local state
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => ({
            ...preset,
            elements: preset.elements.map(el => {
              if (el.id !== elementId) return el
              return {
                ...el,
                ...data,
                properties: data.properties ? { ...el.properties, ...data.properties } : el.properties,
              }
            }),
          })),
        }
      })
    } catch (err: any) {
      console.error('Failed to update element:', err)
    }
  }, [api, elements, sendUpdate])

  const handleUpdateInstance = useCallback(async (instanceId: string, data: Partial<Instance>) => {
    try {
      await api.updateInstance(instanceId, data)

      // Find which element this instance belongs to
      const parentEl = elements.find(el => el.instances.some(i => i.id === instanceId))
      if (parentEl) {
        sendUpdate({
          action: 'update_instance',
          element: parentEl.type,
          elementData: { id: parentEl.id },
          instanceData: { id: instanceId, ...data },
        })
      }

      // Update local state
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => ({
            ...preset,
            elements: preset.elements.map(el => ({
              ...el,
              instances: el.instances.map(inst =>
                inst.id === instanceId ? { ...inst, ...data } : inst
              ),
            })),
          })),
        }
      })
    } catch (err: any) {
      console.error('Failed to update instance:', err)
    }
  }, [api, elements, sendUpdate])

  const handleDeleteInstance = useCallback(async (instanceId: string) => {
    try {
      await api.deleteInstance(instanceId)

      sendUpdate({
        action: 'delete_instance',
        instanceData: { id: instanceId },
      })

      // Remove from local state
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => ({
            ...preset,
            elements: preset.elements.map(el => ({
              ...el,
              instances: el.instances.filter(inst => inst.id !== instanceId),
            })),
          })),
        }
      })
    } catch (err: any) {
      console.error('Failed to delete instance:', err)
    }
  }, [api, sendUpdate])

  const handleAddInstance = useCallback(async (elementId: string) => {
    try {
      const { instance } = await api.createInstance(elementId, {
        position: { x: 8, y: 1, z: 8 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        enabled: true,
      })

      sendUpdate({
        action: 'add_instance',
        elementData: { id: elementId },
        instanceData: instance,
      })

      // Add to local state
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => ({
            ...preset,
            elements: preset.elements.map(el => {
              if (el.id !== elementId) return el
              return { ...el, instances: [...el.instances, instance] }
            }),
          })),
        }
      })
    } catch (err: any) {
      console.error('Failed to create instance:', err)
    }
  }, [api, sendUpdate])

  // -----------------------------------------------------------------------
  // Widget: Add / Delete
  // -----------------------------------------------------------------------

  const handleAddElement = useCallback(async (type: ElementType) => {
    if (!activePreset) return
    const count = elements.filter(e => e.type === type).length + 1
    const defaults: Record<ElementType, Record<string, any>> = {
      video: { liveSrc: '', offType: 0, volume: 1, isLive: false },
      image: { textureSrc: '' },
      model: { modelSrc: '' },
      sound: { audioSrc: '', volume: 1, loop: false },
      widget: { controlType: 1, value: false, order: 0 },
    }
    try {
      const { element } = await api.createElement(activePreset.id, {
        type,
        name: `${type.charAt(0).toUpperCase() + type.slice(1)} ${count}`,
        enabled: true,
        properties: defaults[type],
      })
      const { instance } = await api.createInstance(element.id, {
        position: { x: 8, y: 1, z: 8 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        enabled: true,
      })
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => {
            if (preset.id !== activePreset.id) return preset
            return { ...preset, elements: [...preset.elements, { ...element, instances: [instance] }] }
          }),
        }
      })
      sendUpdate({ action: 'add_element', element: type, elementData: { ...element, instances: [instance] } })
    } catch (err: any) {
      console.error(`Failed to add ${type}:`, err)
    }
  }, [api, activePreset, elements, sendUpdate])

  const handleAddWidget = useCallback(async () => {
    if (!activePreset) return
    try {
      const { element } = await api.createElement(activePreset.id, {
        type: 'widget',
        name: `Widget ${elements.filter(e => e.type === 'widget').length + 1}`,
        enabled: true,
        properties: { controlType: 1, value: false, order: 0 },
      })
      // Add to local state (widgets have no instances)
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => {
            if (preset.id !== activePreset.id) return preset
            return { ...preset, elements: [...preset.elements, { ...element, instances: [] }] }
          }),
        }
      })
      sendUpdate({ action: 'add_element', element: 'widget', elementData: element })
    } catch (err: any) {
      console.error('Failed to add widget:', err)
    }
  }, [api, activePreset, elements, sendUpdate])

  const handleDeleteWidget = useCallback(async (elementId: string) => {
    try {
      await api.deleteElement(elementId)
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => ({
            ...preset,
            elements: preset.elements.filter(el => el.id !== elementId),
          })),
        }
      })
      sendUpdate({ action: 'delete_element', element: 'widget', elementData: { id: elementId } })
    } catch (err: any) {
      console.error('Failed to delete widget:', err)
    }
  }, [api, sendUpdate])

  // -----------------------------------------------------------------------
  // Copy scene ID
  // -----------------------------------------------------------------------

  const copySceneId = () => {
    navigator.clipboard.writeText(sceneId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (loading) return <p className="text-gray-400">Loading scene...</p>
  if (error) return <p className="text-red-400">Error: {error}</p>
  if (!scene) return <p className="text-gray-400">Scene not found.</p>

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold">{scene.name}</h1>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${connected ? 'bg-green-900/50 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-gray-600'}`} />
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <code className="text-sm text-gray-500 font-mono">{sceneId}</code>
          <button onClick={copySceneId} className="text-xs text-blue-400 hover:text-blue-300">
            {copied ? 'Copied!' : 'Copy ID'}
          </button>
        </div>
        {activePreset && (
          <p className="mt-1 text-sm text-gray-500">Preset: {activePreset.name}</p>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800 pb-px">
        {TABS.map(tab => {
          const count = tab.key === 'moderation' ? 0 : elements.filter(el => el.type === tab.key).length
          return (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                activeTab === tab.key
                  ? 'bg-gray-800 text-white border-b-2 border-blue-500'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              }`}>
              {tab.label} {count > 0 && <span className="ml-1 text-xs text-gray-500">({count})</span>}
            </button>
          )
        })}
      </div>

      {/* Moderation tab */}
      {activeTab === 'moderation' && (
        <ModerationPanel sendMessage={sendMessage} />
      )}

      {/* Widget tab */}
      {activeTab === 'widget' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">Widgets ({filteredElements.length})</p>
            <button onClick={handleAddWidget} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors">
              + Add Widget
            </button>
          </div>
          {filteredElements.length === 0 ? (
            <p className="text-gray-500 text-sm py-8 text-center">No widgets in this preset.</p>
          ) : (
            filteredElements
              .sort((a, b) => (a.properties?.order ?? 0) - (b.properties?.order ?? 0))
              .map(el => (
                <WidgetElementEditor key={el.id} element={el}
                  onUpdateElement={handleUpdateElement}
                  onDelete={handleDeleteWidget} />
              ))
          )}
        </div>
      )}

      {/* Element list (video/image/model/sound) */}
      {activeTab !== 'moderation' && activeTab !== 'widget' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">{activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}s ({filteredElements.length})</p>
            <button onClick={() => handleAddElement(activeTab as ElementType)}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors">
              + Add {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
            </button>
          </div>
          {filteredElements.length === 0 ? (
            <p className="text-gray-500 text-sm py-8 text-center">No {activeTab} elements in this preset.</p>
          ) : (
            filteredElements.map(el => {
              const editorProps = {
                element: el,
                onUpdateElement: handleUpdateElement,
                onUpdateInstance: handleUpdateInstance,
                onDeleteInstance: handleDeleteInstance,
                onAddInstance: handleAddInstance,
              }

              switch (el.type) {
                case 'video': return <VideoElementEditor key={el.id} {...editorProps} />
                case 'image': return <ImageElementEditor key={el.id} {...editorProps} />
                case 'model': return <ModelElementEditor key={el.id} {...editorProps} />
                case 'sound': return <SoundElementEditor key={el.id} {...editorProps} />
                default: return null
              }
            })
          )}
        </div>
      )}
    </div>
  )
}
