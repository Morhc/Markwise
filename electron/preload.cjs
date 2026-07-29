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
