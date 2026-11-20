// Keep existing choices and weather cache when switching storage namespaces.
export function migratePreferences(storage: Storage) {
  for (const suffix of ['background-style', 'stage-style', 'scene-bar-style', 'air-opacity', 'sky-settings-v1', 'weather', 'weather-current-v2']) {
    try {
      const oldKey = 'monitors-focus.' + suffix
      const newKey = 'myscreen.' + suffix
      const value = storage.getItem(oldKey)
      if (value === null) continue
      if (storage.getItem(newKey) === null) storage.setItem(newKey, value)
      storage.removeItem(oldKey)
    } catch {
      // Storage can be unavailable. Never remove a value before copying it.
    }
  }
}
