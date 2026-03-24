import { SceneSettingType, WidgetControlType } from '../enums/index.js';
import { SceneElement } from './elements.js';

// ---------------------------------------------------------------------------
// Scene hierarchy
// ---------------------------------------------------------------------------

export interface ScenePreset {
  id: string;
  sceneId: string;
  name: string;
  locale?: string;
  elements?: SceneElement[];
}

export interface SceneSetting {
  id: string;
  sceneId: string;
  type: SceneSettingType;
  value: Record<string, unknown>;
}

export interface Scene {
  id: string;
  ownerId: string;
  orgId?: string;
  name: string;
  description?: string;
  thumbnailUrl?: string;
  activePresetId?: string;
  presets?: ScenePreset[];
  settings?: SceneSetting[];
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// SDK initialization
// ---------------------------------------------------------------------------

export interface VLMInitConfig {
  env?: 'dev' | 'staging' | 'prod';
  sceneId?: string;
  debug?: boolean | string[];
  widgets?: WidgetConfig[];
}

export interface WidgetConfig {
  id: string;
  type?: WidgetControlType;
  value?: unknown;
  init?: () => void;
  update?: (value: unknown) => void;
  delete?: () => void;
}
