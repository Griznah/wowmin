// npm passes options it doesn't recognise to scripts as npm_config_<name>
// environment variables (`npm run x --source=/path`), and eats the value of
// `--source /path` without a standalone `--`. The map commands accept both
// forms through these.

export function readNpmConfigValue(name) {
  const value = process.env[`npm_config_${name}`];
  return value === undefined || value === '' || value === 'true' ? undefined : value;
}

export function readNpmConfigBoolean(name) {
  const value = process.env[`npm_config_${name}`];
  if (value === undefined || value === '') return undefined;
  return !['false', '0', 'no', 'off'].includes(value.toLowerCase());
}

// Throws when npm took any of the value options `names` without its value.
export function assertNpmValueOptionsHaveValues(names) {
  const missingValues = names.filter((name) => process.env[`npm_config_${name}`] === 'true');
  if (missingValues.length === 0) return;
  const flags = missingValues.map((name) => `--${name.replaceAll('_', '-')}`).join(', ');
  throw new Error(
    `npm consumed ${flags} without their values. Put a standalone -- before the command's arguments ` +
    '(recommended), or use npm config syntax such as --source=/path --quality=100.'
  );
}
