/**
 * EntityStore — Observable entity map bridging imperative adapter calls to React rendering.
 *
 * The HyperfyAdapter writes to this store (createEntity, updateEntity, destroyEntity).
 * The HyperfyRenderer subscribes and re-renders whenever the store changes.
 */

let nextEntityId = 1
const entities = new Map()
const listeners = new Set()

export class EntityStore {
  /**
   * Subscribe to store changes. Returns an unsubscribe function.
   * @param {() => void} callback
   * @returns {() => void}
   */
  static subscribe(callback) {
    listeners.add(callback)
    return () => listeners.delete(callback)
  }

  /** Notify all listeners of a state change. */
  static notify() {
    for (const fn of listeners) {
      fn()
    }
  }

  /**
   * Create a new entity with default empty state.
   * @returns {number} The entity handle (numeric ID).
   */
  static createEntity() {
    const id = nextEntityId++
    entities.set(id, {
      id,
      type: null, // 'video' | 'image' | 'model' | 'audio' | 'plane'
      transform: null,
      material: null,
      video: null,
      audio: null,
      collider: null,
      model: null,
      pointerDown: null,
      destroyed: false,
    })
    this.notify()
    return id
  }

  /**
   * Mark an entity as destroyed. It is filtered from getAllEntities immediately,
   * and removed from the map on the next tick to allow React cleanup.
   * @param {number} id
   */
  static destroyEntity(id) {
    const entity = entities.get(id)
    if (entity) {
      entity.destroyed = true
      this.notify()
      // Defer actual removal so React can unmount cleanly
      setTimeout(() => entities.delete(id), 0)
    }
  }

  /**
   * Get a single entity by handle.
   * @param {number} id
   * @returns {object | undefined}
   */
  static getEntity(id) {
    return entities.get(id)
  }

  /**
   * Check if an entity exists and is not destroyed.
   * @param {number} id
   * @returns {boolean}
   */
  static entityExists(id) {
    const e = entities.get(id)
    return !!e && !e.destroyed
  }

  /**
   * Merge updates into an existing entity and notify listeners.
   * @param {number} id
   * @param {object} updates
   */
  static updateEntity(id, updates) {
    const entity = entities.get(id)
    if (entity && !entity.destroyed) {
      Object.assign(entity, updates)
      this.notify()
    }
  }

  /**
   * Return all live (non-destroyed) entities.
   * @returns {object[]}
   */
  static getAllEntities() {
    return Array.from(entities.values()).filter((e) => !e.destroyed)
  }

  /**
   * Clear all entities. Used when switching presets or destroying VLM.
   */
  static clear() {
    entities.clear()
    nextEntityId = 1
    this.notify()
  }
}
