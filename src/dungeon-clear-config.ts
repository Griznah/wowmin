const DEFAULT_DUNGEON_CLEAR_PORT = 8790;

export function normalizeDungeonClearUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('WOWMIN_DUNGEON_CLEAR_URL must use http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('WOWMIN_DUNGEON_CLEAR_URL must not contain credentials.');
  }
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

export function deriveDungeonClearUrl(scheme: string, hostHeader: string | undefined): string {
  const protocol = scheme === 'https' ? 'https:' : 'http:';
  let requestUrl: URL;
  try {
    requestUrl = new URL(`${protocol}//${hostHeader || 'localhost'}`);
  } catch {
    requestUrl = new URL(`${protocol}//localhost`);
  }
  const hostname = requestUrl.hostname.startsWith('[')
    ? requestUrl.hostname
    : requestUrl.hostname.includes(':') ? `[${requestUrl.hostname}]` : requestUrl.hostname;
  return `${protocol}//${hostname}:${DEFAULT_DUNGEON_CLEAR_PORT}/`;
}

export function buildContentSecurityPolicy(dungeonClearUrl: string): string {
  const frameOrigin = new URL(dungeonClearUrl).origin;
  return [
    "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // The 3D view decodes meshopt-compressed models with WebAssembly, and
    // GLTFLoader reads embedded images through blob URLs.
    "script-src 'self' 'wasm-unsafe-eval'",
    "img-src 'self' https: data: blob:",
    "connect-src 'self' blob:",
    `frame-src ${frameOrigin}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
