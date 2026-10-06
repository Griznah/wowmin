import * as fs from 'fs/promises';
import * as path from 'path';
import type { LogMonitorInspectionResult, LogMonitorFileTailResult, LogMonitorAppenderInfo, LogMonitorLoggerInfo, LogMonitorFileInfo } from './types/electron';

const configPath = process.env.WOWMIN_WORLD_CONFIG || '/stuff/Source/azerothcore-wotlk/env/dist/etc/worldserver.conf';
const logsDirectory = process.env.WOWMIN_LOG_DIR || '/stuff/Source/azerothcore-wotlk/env/dist/bin';

export async function inspectLocalLogs(): Promise<LogMonitorInspectionResult> {
  const content = await fs.readFile(configPath, 'utf8');
  const settings = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (match) settings.set(match[1], match[2]);
  }
  const files: LogMonitorFileInfo[] = [];
  const warnings: string[] = [];
  for (const entry of await fs.readdir(logsDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(logsDirectory, entry.name);
    const stat = await fs.stat(filePath);
    files.push({ path: filePath, name: entry.name, size: stat.size,
      modifiedAt: stat.mtime.toISOString(), readable: true, sourceHints: ['logs-dir'], matchedAppenderNames: [] });
  }
  const appenders: LogMonitorAppenderInfo[] = [];
  for (const [key, value] of settings) {
    if (!key.startsWith('Appender.')) continue;
    const parts = value.split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
    const typeId = Number(parts[0]);
    const fileName = typeId === 2 ? parts[3] || null : null;
    const appenderName = key.slice('Appender.'.length);
    const matches = fileName && fileName.includes('%s')
      ? files.filter((file) => file.name.startsWith(fileName.split('%s')[0]) && file.name.endsWith(fileName.split('%s').at(-1) || '')).map((file) => file.path)
      : [];
    const resolvedPath = fileName && !matches.length && !fileName.includes('%s')
      ? path.resolve(logsDirectory, fileName) : null;
    appenders.push({ name: appenderName, type: typeId === 2 ? 'file' : typeId === 1 ? 'console' : typeId === 3 ? 'db' : 'none',
      typeId, logLevel: Number(parts[1]) || 0, logLevelLabel: parts[1] || '', flags: Number(parts[2]) || 0,
      optionalValues: parts.slice(3), fileName, mode: parts[4] || null, maxFileSize: Number(parts[5]) || null,
      resolvedPath, isDynamicFile: Boolean(fileName?.includes('%s')), matchedDynamicFiles: matches });
    for (const file of files) {
      if (file.path === resolvedPath || matches.includes(file.path)) {
        file.matchedAppenderNames.push(appenderName);
        file.sourceHints.push('configured');
      }
    }
    if (resolvedPath && !files.some((file) => file.path === resolvedPath)) warnings.push(`Configured log file missing: ${resolvedPath}`);
  }
  const loggers: LogMonitorLoggerInfo[] = [];
  for (const [key, value] of settings) {
    if (!key.startsWith('Logger.')) continue;
    const [level, names = ''] = value.split(',', 2);
    const appenderNames = names.trim().split(/\s+/).filter(Boolean);
    loggers.push({ name: key.slice('Logger.'.length), logLevel: Number(level) || 0, logLevelLabel: level.trim(),
      appenderNames, resolvedFiles: appenders.filter((appender) => appenderNames.includes(appender.name))
        .flatMap((appender) => [appender.resolvedPath, ...(appender.matchedDynamicFiles || [])].filter((file): file is string => Boolean(file))) });
  }
  return { success: true, message: `Discovered ${appenders.length} appenders, ${loggers.length} loggers, and ${files.length} readable log files.`,
    inspectedAt: new Date().toISOString(), host: 'localhost', port: 0, username: 'local', configPath,
    configDirectory: path.dirname(configPath), logsDir: settings.get('LogsDir')?.replace(/^"|"$/g, '') || '',
    resolvedLogsDir: logsDirectory, packetLogFile: settings.get('PacketLogFile') || null,
    appenders, loggers, files, warnings };
}

export async function readLocalLogTail(filePath: string, maxBytes = 32 * 1024): Promise<LogMonitorFileTailResult> {
  const root = await fs.realpath(logsDirectory);
  const resolved = await fs.realpath(filePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Log file is outside configured log directory.');
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error('Selected log is not a file.');
  const size = Math.min(stat.size, Math.max(1024, Math.min(Number(maxBytes) || 32768, 1024 * 1024)));
  const start = stat.size - size;
  const handle = await fs.open(resolved, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    return { success: true, path: resolved, content: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead,
      truncated: start > 0, message: start > 0 ? `Showing the last ${bytesRead} bytes.` : 'Showing the full file contents.' };
  } finally {
    await handle.close();
  }
}
