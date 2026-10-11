const esbuild = require('esbuild');
const path = require('path');

const isDev = process.argv.includes('--watch');

// Native web-service build.
const webServerConfig = {
  entryPoints: [path.join(__dirname, 'src/web-server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/web-server.js',
  external: ['mysql2', 'ssh2', 'xml2js'],
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
