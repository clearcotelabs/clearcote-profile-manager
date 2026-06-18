// Electron-side types. Kept self-contained (decoupled from the renderer's
// src/types/profile.ts) so the electron build has no cross-rootDir imports.
// The two shapes are intentionally identical — see PLAN.md.

export interface Proxy {
  server: string;
  username?: string;
  password?: string;
}

export interface Profile {
  id: string;
  name: string;
  notes?: string;
  tags?: string[];
  group?: string;
  fingerprint: string;
  platform?: string;
  brand?: string;
  gpuVendor?: string;
  gpuRenderer?: string;
  hardwareConcurrency?: number;
  timezone?: string;
  acceptLanguage?: string;
  location?: string;
  webrtcIp?: string;
  geoip?: boolean;
  proxy?: Proxy;
  extraArgs?: string[];
  createdAt: string;
  updatedAt: string;
  lastLaunchedAt?: string;
  userDataDir?: string;
}

export interface Settings {
  binaryPath?: string;
  theme?: "dark" | "light";
}

export interface LaunchResult {
  ok: boolean;
  pid?: number;
  error?: string;
}
