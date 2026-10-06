import * as fs from 'fs';
import * as path from 'path';
import packageJson from '../package.json';

type Handler = (event: Record<string, never>, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

export const ipcMain = {
  handle(channel: string, handler: Handler): void {
    if (handlers.has(channel)) {
      throw new Error(`Handler already registered for ${channel}`);
    }
    handlers.set(channel, handler);
  },
  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`Unknown API channel: ${channel}`);
    }
    return handler({}, ...args);
  },
};

const ready = Promise.resolve();
const windows: BrowserWindow[] = [];

export const app = {
  name: 'WoW Admin',
  getName: (): string => 'WoW Admin',
  getVersion: (): string => packageJson.version,
  getPath(name: string): string {
    if (name !== 'userData') {
      throw new Error(`Unsupported app path requested in web mode: ${name}`);
    }
    const userDataPath = process.env.WOWMIN_DATA_DIR || path.join(process.cwd(), '.wowmin-data');
    fs.mkdirSync(userDataPath, { recursive: true });
    return userDataPath;
  },
  whenReady: (): Promise<void> => ready,
  on: (): void => undefined,
  quit: (): void => undefined,
};

export class BrowserWindow {
  public readonly webContents = { send: (): void => undefined };

  constructor(_options?: unknown) {
    windows.push(this);
  }

  loadFile(_filePath: string): void {}

  static getAllWindows(): BrowserWindow[] {
    return [...windows];
  }
}

export const Menu = {
  buildFromTemplate: (_template: unknown[]): Record<string, never> => ({}),
  setApplicationMenu: (_menu: unknown): void => undefined,
};

export const dialog = {
  showMessageBox: async (_options: unknown): Promise<{ response: number }> => ({ response: 0 }),
};

export const shell = {
  openExternal: async (target: string): Promise<void> => {
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only HTTP(S) links can be opened in web mode.');
    }
  },
};

export class IpcMainInvokeEvent {}
