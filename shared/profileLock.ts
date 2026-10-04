/** Same lock boundary used by GUI and standalone readers; no config migrations. */
export function isProfileLocked(config: Record<string, unknown>): boolean {
  return ['decryptKey', 'aiModelApiKey', 'aiModelProfilesJson'].some(key =>
    typeof config[key] === 'string' && (config[key] as string).startsWith('lock:'))
}
