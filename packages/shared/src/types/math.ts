import { ClickEventType } from '../enums/index.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface TransformData {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface ClickEvent {
  type: ClickEventType;
  showFeedback: boolean;
  hoverText?: string;
  externalLink?: string;
  sound?: string;
  moveTo?: { position: Vec3; cameraTarget?: Vec3 };
  teleportTo?: string;
}
