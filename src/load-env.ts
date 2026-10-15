import * as path from 'path';

// Loads wowmin's settings files into process.env at startup, so the web
// service needs no --env-file flag. In order of precedence:
// - variables already set in the environment (an export, or a systemd unit's
//   EnvironmentFile);
// - the system file, /etc/wowmin.env (on Windows %ProgramData%\wowmin\wowmin.env);
// - .env in the project root, beside dist/, as the fallback.
// A file never overrides a value already set, so loading the files in that
// order gives that precedence. Imported first by web-server.ts, because
// main.ts reads its settings as soon as it loads.

type LoadEnvFile = (file: string) => void;

// The settings files to load, the system one first.
export function settingsFiles(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  projectRoot = path.resolve(__dirname, '..'),
): string[] {
  const system = platform === 'win32'
    ? env.ProgramData ? path.win32.join(env.ProgramData, 'wowmin', 'wowmin.env') : null
    : '/etc/wowmin.env';
  return [...(system ? [system] : []), path.join(projectRoot, '.env')];
}

// Loads each file that exists. A file the service may not read is skipped
// quietly when wowmin's settings are already set: a systemd unit reads its
// EnvironmentFile as root, and the service itself (DynamicUser) cannot.
export function loadSettingsFiles(
  files: string[],
  load: LoadEnvFile = (file) => process.loadEnvFile(file),
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): void {
  const alreadySet = () => Object.keys(env).some((name) => name.startsWith('WOWMIN_'));
  for (const file of files) {
    try {
      load(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      if ((code === 'EACCES' || code === 'EPERM') && alreadySet()) continue;
      warn(`Could not read ${file}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

loadSettingsFiles(settingsFiles());
