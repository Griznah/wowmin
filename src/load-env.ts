import * as path from 'path';

// Loads wowmin's .env (in the project root, beside dist/) into process.env, so
// the web service needs no --env-file flag. Variables already set in the
// environment win. Imported first by web-server.ts, because main.ts reads its
// settings as soon as it loads.
try {
  process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.warn(`Could not read .env: ${error instanceof Error ? error.message : error}`);
  }
}
