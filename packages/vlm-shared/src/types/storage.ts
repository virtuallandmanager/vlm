import { SceneElement, SceneElementInstance } from './elements.js';

// ---------------------------------------------------------------------------
// Element store — keyed by customId for fast SDK lookup
// ---------------------------------------------------------------------------

export interface ElementStore {
  configs: Record<string, SceneElement>;
  instances: Record<string, SceneElementInstance>;
}

export interface ModelStore extends ElementStore {
  /** Sks of model elements whose file the platform cannot load (adapter resolveModelSrc returned null). */
  missing: Set<string>;
}

export interface VLMStorage {
  videos: ElementStore;
  images: ElementStore;
  models: ModelStore;
  sounds: ElementStore;
  nfts: ElementStore;
  claimPoints: ElementStore;
  widgets: ElementStore;
}
