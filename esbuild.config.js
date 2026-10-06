const esbuild = require('esbuild');
const path = require('path');

const isDev = process.argv.includes('--watch');

// Main process build config
const mainConfig = {
  entryPoints: [path.join(__dirname, 'src/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/main.js',
  // Keep native / platform-specific runtime dependencies external so CI builds
  // do not try to inline optional binaries that vary across runners.
  external: ['electron', 'mysql2', 'electron-store', 'ssh2', 'xml2js'],
  sourcemap: true,
  minify: !isDev,
  format: 'cjs',
};

// Preload script build config
const preloadConfig = {
  entryPoints: [path.join(__dirname, 'src/preload.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/preload.js',
  external: ['electron'],
  sourcemap: true,
  minify: !isDev,
  format: 'cjs',
};

// Native web-service build. It reuses the Electron IPC handlers through a
// lightweight compatibility shim, keeping desktop and web behavior aligned.
const webServerConfig = {
  entryPoints: [path.join(__dirname, 'src/web-server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/web-server.js',
  external: ['mysql2', 'ssh2', 'xml2js'],
  alias: {
    electron: path.join(__dirname, 'src/web-electron-shim.ts'),
  },
  sourcemap: true,
  minify: !isDev,
  format: 'cjs',
};

const webApiConfig = {
  entryPoints: [path.join(__dirname, 'renderer/scripts/web-api.ts')],
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  outfile: 'dist/web-api.js',
  sourcemap: true,
  minify: !isDev,
  format: 'iife',
};

// Renderer build config
const rendererConfig = {
  entryPoints: [path.join(__dirname, 'renderer/scripts/app.ts')],
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  outfile: 'dist/renderer.js',
  sourcemap: true,
  minify: !isDev,
  format: 'iife',
};

async function build() {
  try {
    await Promise.all([
      esbuild.build(mainConfig),
      esbuild.build(preloadConfig),
      esbuild.build(webServerConfig),
      esbuild.build(webApiConfig),
      esbuild.build(rendererConfig),
    ]);
    console.log('Build completed successfully');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

async function watch() {
  const contexts = await Promise.all([
    esbuild.context(mainConfig),
    esbuild.context(preloadConfig),
    esbuild.context(webServerConfig),
    esbuild.context(webApiConfig),
    esbuild.context(rendererConfig),
  ]);

  await Promise.all(contexts.map(ctx => ctx.watch()));
  console.log('Watching for changes...');
}

if (isDev) {
  watch();
} else {
  build();
}
