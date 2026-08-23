const SEPARATOR = /[\\/]/

export function baseName(path: string) {
  const parts = path.split(SEPARATOR)
  return parts[parts.length - 1] || path
}

export function dirName(path: string) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index > 0 ? path.slice(0, index) : ''
}

/** File name without its final extension. */
export function fileStem(nameOrPath: string) {
  return baseName(nameOrPath).replace(/\.[^/.]+$/, '')
}

export function extension(path: string) {
  const name = baseName(path)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toLowerCase() : ''
}

/** Last two folders of a path's directory, e.g. `…/Diagrams/orders`, for compact lists. */
export function shortDirName(path: string) {
  const segments = dirName(path).split(SEPARATOR).filter(Boolean)
  if (segments.length <= 2) {
    return segments.join('/')
  }
  return `…/${segments.slice(-2).join('/')}`
}
