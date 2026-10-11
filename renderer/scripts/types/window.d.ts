import type { WowminAPI } from './wowmin-api';

declare global {
  interface Window {
    wowminAPI: WowminAPI;
  }
}

export {};
