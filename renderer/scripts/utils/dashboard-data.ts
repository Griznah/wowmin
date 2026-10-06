export function getServerUptime(info: string): string | null {
  return info.match(/^Server uptime:\s*(.+)$/im)?.[1]?.trim() || null;
}

export function getEnglishMotd(message: string): string | null {
  const lines = message.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex((line) => /^enUS\s*:/i.test(line));
  if (start < 0) return null;

  const value = [lines[start].replace(/^enUS\s*:\s*/i, '')];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[a-z]{2}[A-Z]{2}\s*:/i.test(lines[index])) break;
    if (lines[index]) value.push(lines[index]);
  }
  return value.join('\n').trim() || null;
}
