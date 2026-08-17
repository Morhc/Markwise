'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const SIMPLE_TYPES = new Set(['ready', 'opened', 'clean', 'dirty', 'stopFind'])

function sanitizeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null
  const { type } = message
  if (typeof type !== 'string') return null

  if (SIMPLE_TYPES.has(type)) return { type }

  if (type === 'openLink' && typeof message.href === 'string') {
    return { type, href: message.href.slice(0, 8192) }
  }

  if (type === 'editImage' && typeof message.src === 'string') {
    return { type, src: message.src.slice(0, 1024 * 1024) }
  }

  if (type === 'find' && typeof message.query === 'string') {
    return {
      type,
      query: message.query.slice(0, 4096),
      forward: message.forward !== false,
      findNext: message.findNext === true,
    }
  }

  // Electron currently keeps pasted images embedded. Acknowledge the newer
  // shared renderer request so it can fall back immediately instead of waiting
  // for the native-image localization timeout used by the macOS host.
  if (type === 'saveImage' && Number.isSafeInteger(message.id) && message.id > 0) {
    return { type, id: message.id }
  }

  return null
}

const bridge = Object.freeze({
  postMessage(message) {
    const safeMessage = sanitizeMessage(message)
    if (safeMessage) ipcRenderer.send('editor-message', safeMessage)
  },
})

contextBridge.exposeInMainWorld('webkit', Object.freeze({
  messageHandlers: Object.freeze({ bridge }),
}))

// The Electron host owns the initial open and responds to the renderer's ready
// message, so suppress the renderer's standalone empty-document bootstrap.
contextBridge.exposeInMainWorld('MW_PENDING_DOC', true)
