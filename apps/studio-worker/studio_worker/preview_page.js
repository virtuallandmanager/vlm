// Runs inside Decentraland's wearable-preview page (as a Playwright init script, before the page's own code).
// It records the messages the preview posts to its parent (here, itself), and gives render.py two calls:
// __studio.update(files, items) hands the preview items the way the Builder does, with the GLBs as in-page blob
// URLs, and __studio.call(namespace, method, params) is the preview's controller over postMessage.
(() => {
  const MALE = 'urn:decentraland:off-chain:base-avatars:BaseMale'
  const FEMALE = 'urn:decentraland:off-chain:base-avatars:BaseFemale'
  const pending = {}
  let nextId = 0
  const studio = { messages: [] }
  window.__studio = studio

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data.type !== 'string') return
    if (data.type === 'controller_response' && data.payload && pending[data.payload.id]) {
      const { resolve, reject } = pending[data.payload.id]
      delete pending[data.payload.id]
      data.payload.ok ? resolve(data.payload.result) : reject(new Error(data.payload.error))
    } else if (['ready', 'load', 'error'].includes(data.type)) {
      studio.messages.push({ type: data.type, payload: data.payload, at: performance.now() })
    }
  })

  studio.count = (type) => studio.messages.filter((m) => m.type === type).length

  studio.call = (namespace, method, params) =>
    new Promise((resolve, reject) => {
      const id = 'studio-' + nextId++
      pending[id] = { resolve, reject }
      window.postMessage({ type: 'controller_request', payload: { id, namespace, method, params: params || [] } }, '*')
    })

  // Resolves after the next two frames, so a screenshot shows the camera or animation change just made
  studio.frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  // files: {name: base64}; items: [{category, glbs: {male|female|unisex: name}, meta}]
  studio.update = (files, items) => {
    const base64s = items.map((item) => {
      const shapes = { male: [MALE], female: [FEMALE], unisex: [MALE, FEMALE] }
      const representations = Object.entries(item.glbs).map(([shape, name]) => {
        const bin = Uint8Array.from(atob(files[name]), (c) => c.charCodeAt(0))
        const url = URL.createObjectURL(new Blob([bin], { type: 'model/gltf-binary' }))
        return { bodyShapes: shapes[shape], mainFile: name, contents: [{ key: name, url }],
                 overrideHides: [], overrideReplaces: [] }
      })
      const meta = item.meta || {}
      const name = meta.name || item.category
      const def = { id: 'urn:decentraland:off-chain:studio-preview:' + item.category, name, description: '',
        i18n: [{ code: 'en', text: name }], thumbnail: '', image: '', rarity: 'epic' }
      if (item.category === 'emote') {
        // an emote travels as an emoteDataADR74 definition in place of a wearable's data
        def.emoteDataADR74 = { category: 'dance', tags: meta.tags || [], loop: !!meta.loop, representations }
      } else {
        def.data = { category: item.category, hides: meta.hides || [], replaces: meta.replaces || [],
          tags: meta.tags || [], representations,
          // the Builder sets this on new upper_body items so the base hands still show
          removesDefaultHiding: item.category === 'upper_body' ? ['hands'] : [] }
      }
      return btoa(JSON.stringify(def))
    })
    window.postMessage({ type: 'update', payload: { options: { base64s } } }, '*')
  }
})()
