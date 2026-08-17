'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const IMAGE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'data:'])

function externalUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) return null
  try {
    const url = new URL(raw)
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

function normalizeImageSource(raw, homeDirectory) {
  if (typeof raw !== 'string') return ''
  const source = raw.trim()
  if (!source) return ''

  try {
    const url = new URL(source)
    if (IMAGE_PROTOCOLS.has(url.protocol)) return source
    return ''
  } catch {
    // A path or relative Markdown URL is handled below.
  }

  let resolved = source
  if (resolved === '~' || resolved.startsWith('~/')) {
    resolved = path.join(homeDirectory, resolved.slice(2))
  }
  return path.isAbsolute(resolved) ? pathToFileURL(resolved).toString() : source
}

function documentBaseUrl(filePath) {
  const directory = path.dirname(path.resolve(filePath))
  const directoryPath = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`
  return pathToFileURL(directoryPath).toString()
}

function defaultPdfPath(filePath) {
  if (!filePath) return 'Untitled.pdf'
  const parsed = path.parse(path.resolve(filePath))
  return path.join(parsed.dir, `${parsed.name}.pdf`)
}

async function atomicWrite(filePath, contents) {
  const directory = path.dirname(filePath)
  const basename = path.basename(filePath)
  const suffix = crypto.randomBytes(8).toString('hex')
  const temporaryPath = path.join(directory, `.${basename}.${process.pid}.${suffix}.tmp`)
  let handle

  try {
    let mode = 0o666
    try {
      mode = (await fs.promises.stat(filePath)).mode
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    handle = await fs.promises.open(temporaryPath, 'wx', mode)
    await handle.writeFile(contents)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.promises.rename(temporaryPath, filePath)

    try {
      const directoryHandle = await fs.promises.open(directory, 'r')
      await directoryHandle.sync()
      await directoryHandle.close()
    } catch {
      // Some filesystems do not allow syncing directories.
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fs.promises.unlink(temporaryPath).catch(() => {})
    throw error
  }
}

module.exports = {
  atomicWrite,
  defaultPdfPath,
  documentBaseUrl,
  externalUrl,
  normalizeImageSource,
}
