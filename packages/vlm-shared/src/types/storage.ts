import { SceneElement, SceneElementInstance } from './elements.js';

// ---------------------------------------------------------------------------
// Element store — keyed by customId for fast SDK lookup
// ---------------------------------------------------------------------------

export interface ElementStore {
  configs: Record<string, SceneElement>;
  instances: Record<string, SceneElementInstance>;
}

export interface VLMStorage {
  videos: ElementStore;
  images: ElementStore;
  models: ElementStore;
  sounds: ElementStore;
  nfts: ElementStore;
  claimPoints: ElementStore;
  widgets: ElementStore;
}
