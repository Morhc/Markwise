'use strict'

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
} = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  atomicWrite,
  documentBaseUrl,
  externalUrl,
  normalizeImageSource,
} = require('./files.cjs')

const APP_NAME = 'Markwise'
const EDITOR_PATH = path.join(__dirname, '..', 'app', 'web', 'index.html')
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs')
const MARKDOWN_FILTER = {
  name: 'Markdown and text',
  extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'mdtext', 'txt', 'text'],
}
const IMAGE_FILTER = {
  name: 'Images',
  extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'tif', 'heic'],
}

const documents = new Map()
const smokeTest = process.env.MARKWISE_SMOKE_TEST === '1'
let smokeTestTimer = null
let initialArguments = []

function editorUrl() {
  return pathToFileURL(EDITOR_PATH).toString()
}

function senderDocument(event) {
  const document = documents.get(event.sender.id)
  if (!document || document.window.isDestroyed()) return null
  if (event.senderFrame !== event.sender.mainFrame) return null
  if (event.senderFrame.url !== editorUrl()) return null
  return document
}

function activeDocument() {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) return documents.get(focused.webContents.id) || null
  return documents.values().next().value || null
}

function errorDetail(error) {
  return error instanceof Error ? error.message : String(error)
}

async function showError(title, error, parent = null) {
  const options = {
    type: 'error',
    title: APP_NAME,
    message: title,
    detail: errorDetail(error),
  }
  if (parent && !parent.isDestroyed()) {
    await dialog.showMessageBox(parent, options)
  } else {
    await dialog.showMessageBox(options)
  }
}

function existingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function fileArguments(argv) {
  const start = app.isPackaged ? 1 : 2
  return argv
    .slice(start)
    .filter((argument) => argument && !argument.startsWith('-'))
    .map((argument) => path.resolve(argument))
}

function findOpenDocument(filePath) {
  const resolved = path.resolve(filePath)
  for (const document of documents.values()) {
    if (document.filePath === resolved) return document
  }
  return null
}

async function openPaths(filePaths, createWhenEmpty = false) {
  let opened = false
  for (const filePath of filePaths) {
    if (!existingFile(filePath)) {
      await showError('Could not open file', `The file does not exist: ${filePath}`)
      continue
    }

    const existing = findOpenDocument(filePath)
    if (existing) {
      existing.window.show()
      existing.window.focus()
    } else {
      new DocumentWindow(filePath)
    }
    opened = true
  }

  if (!opened && createWhenEmpty && documents.size === 0) new DocumentWindow()
}

class DocumentWindow {
  constructor(filePath = null) {
    if (smokeTest) console.log(`Smoke: creating window for ${filePath || 'empty document'}`)
    this.filePath = filePath ? path.resolve(filePath) : null
    this.pendingFilePath = this.filePath
    this.ready = false
    this.dirty = false
    this.forceClose = false
    this.closePromptOpen = false
    this.outlineVisible = false
    this.findQuery = ''

    this.window = new BrowserWindow({
      width: 900,
      height: 720,
      minWidth: 600,
      minHeight: 420,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        contextIsolation: true,
        devTools: false,
        navigateOnDragDrop: false,
        nodeIntegration: false,
        preload: PRELOAD_PATH,
        sandbox: true,
        webSecurity: true,
      },
    })

    this.webContentsId = this.window.webContents.id
    documents.set(this.webContentsId, this)
    this.updateTitle()
    this.configureWebContents()

    this.window.once('ready-to-show', () => {
      if (!this.window.isDestroyed()) this.window.show()
    })
    this.window.on('focus', () => this.syncMenuState())
    this.window.on('close', (event) => {
      if (this.forceClose || !this.dirty) return
      event.preventDefault()
      void this.confirmClose()
    })
    this.window.on('closed', () => {
      documents.delete(this.webContentsId)
    })

    this.window.loadFile(EDITOR_PATH).catch((error) => {
      void showError('Could not load the editor', error, this.window)
    })
  }

  configureWebContents() {
    const { webContents } = this.window
    if (smokeTest) {
      webContents.on('console-message', (details, _level, legacyMessage) => {
        console.log(`Renderer: ${details.message || legacyMessage}`)
      })
      webContents.on('did-start-loading', () => console.log('Smoke: renderer started loading'))
      webContents.on('dom-ready', () => console.log('Smoke: renderer DOM ready'))
      webContents.on('did-finish-load', () => console.log('Smoke: renderer finished loading'))
      webContents.on('preload-error', (_event, _preloadPath, error) => {
        console.error(`Smoke: preload error: ${errorDetail(error)}`)
      })
      webContents.on('render-process-gone', (_event, details) => {
        console.error(`Smoke: renderer exited: ${details.reason}`)
      })
    }
    webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternal(url)
      return { action: 'deny' }
    })
    webContents.on('will-navigate', (event, url) => {
      if (url === editorUrl()) return
      event.preventDefault()
      void this.openExternal(url)
    })
    webContents.on('will-attach-webview', (event) => event.preventDefault())
    webContents.on('found-in-page', (_event, result) => {
      const activeMatch = result.matches > 0 ? result.activeMatchOrdinal : 0
      void this.execute(`window.MW.setFindResult(${activeMatch}, ${result.matches})`)
    })
  }

  async execute(script) {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return null
    return this.window.webContents.executeJavaScript(script, true)
  }

  async handleMessage(message) {
    switch (message.type) {
      case 'ready':
        this.ready = true
        if (this.pendingFilePath) {
          const pending = this.pendingFilePath
          this.pendingFilePath = null
          await this.openFile(pending)
        } else {
          await this.execute('window.MW.open("")')
        }
        if (smokeTest) {
          if (smokeTestTimer) clearTimeout(smokeTestTimer)
          console.log('Markwise smoke test: editor ready')
          setImmediate(() => app.quit())
        }
        break
      case 'dirty':
        this.setDirty(true)
        break
      case 'clean':
        this.setDirty(false)
        break
      case 'openLink':
        await this.openExternal(message.href)
        break
      case 'editImage':
        await this.editImageSource(message.src)
        break
      case 'find':
        this.find(message.query, message.forward, message.findNext)
        break
      case 'stopFind':
        this.findQuery = ''
        this.window.webContents.stopFindInPage('clearSelection')
        break
      case 'saveImage':
        await this.execute(`window.MW.nativeReply(${message.id}, null)`)
        break
      default:
        break
    }
  }

  async openFile(filePath) {
    try {
      const resolved = path.resolve(filePath)
      const markdown = await fs.promises.readFile(resolved, 'utf8')
      this.filePath = resolved
      const baseUrl = documentBaseUrl(resolved)
      await this.execute(`window.MW.open(${JSON.stringify(markdown)}, ${JSON.stringify(baseUrl)})`)
      this.setDirty(false)
      this.updateTitle()
    } catch (error) {
      await showError('Could not open file', error, this.window)
    }
  }

  async save(saveAs = false) {
    let destination = saveAs ? null : this.filePath
    if (!destination) {
      const result = await dialog.showSaveDialog(this.window, {
        title: 'Save Markdown',
        defaultPath: this.filePath || 'Untitled.md',
        filters: [
          { name: 'Markdown', extensions: ['md', 'markdown'] },
          { name: 'All files', extensions: ['*'] },
        ],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      })
      if (result.canceled || !result.filePath) return false
      destination = result.filePath
    }

    try {
      const markdown = await this.execute('window.MW.getMarkdown()')
      if (typeof markdown !== 'string') throw new Error('The editor did not return Markdown text.')
      await atomicWrite(destination, markdown)
      this.filePath = path.resolve(destination)
      this.setDirty(false)
      await this.execute('window.MW.markSaved()')
      await this.execute(`window.MW.setBaseURL(${JSON.stringify(documentBaseUrl(this.filePath))})`)
      this.updateTitle()
      return true
    } catch (error) {
      await showError('Could not save file', error, this.window)
      return false
    }
  }

  setDirty(dirty) {
    this.dirty = Boolean(dirty)
    if (typeof this.window.setDocumentEdited === 'function') {
      this.window.setDocumentEdited(this.dirty)
    }
    this.updateTitle()
  }

  updateTitle() {
    const filename = this.filePath ? path.basename(this.filePath) : 'Untitled'
    const prefix = this.dirty ? '* ' : ''
    this.window.setTitle(`${prefix}${filename} - ${APP_NAME}`)
  }

  async confirmClose() {
    if (this.closePromptOpen || !this.dirty || this.window.isDestroyed()) return
    this.closePromptOpen = true
    try {
      const result = await dialog.showMessageBox(this.window, {
        type: 'warning',
        title: APP_NAME,
        message: 'Do you want to save the changes?',
        detail: 'Your changes will be lost if you do not save them.',
        buttons: ['Save', 'Discard', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })

      if (result.response === 2) return
      if (result.response === 0 && !(await this.save())) return
      this.forceClose = true
      this.window.close()
    } finally {
      this.closePromptOpen = false
    }
  }

  async openExternal(rawUrl) {
    const safeUrl = externalUrl(rawUrl)
    if (!safeUrl) return
    await shell.openExternal(safeUrl)
  }

  async editImageSource(current) {
    const choice = await dialog.showMessageBox(this.window, {
      type: 'question',
      title: APP_NAME,
      message: 'Edit image source',
      detail: 'Enter an image URL or path, or choose an image file.',
      buttons: ['Enter URL or path', 'Choose file', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })

    let source = null
    if (choice.response === 0) {
      source = await this.execute(
        `window.prompt("Image URL or file path", ${JSON.stringify(current || '')})`,
      )
      if (source !== null) source = normalizeImageSource(source, os.homedir())
    } else if (choice.response === 1) {
      const selected = await dialog.showOpenDialog(this.window, {
        title: 'Choose image',
        filters: [IMAGE_FILTER, { name: 'All files', extensions: ['*'] }],
        properties: ['openFile'],
      })
      if (!selected.canceled && selected.filePaths[0]) {
        source = pathToFileURL(selected.filePaths[0]).toString()
      }
    }

    if (typeof source === 'string' && source) {
      await this.execute(`window.MW.setImageSrc(${JSON.stringify(source)})`)
    }
  }

  setOutline(visible) {
    this.outlineVisible = Boolean(visible)
    void this.execute(`window.MW.setOutline(${this.outlineVisible})`)
    this.syncMenuState()
  }

  syncMenuState() {
    const item = Menu.getApplicationMenu()?.getMenuItemById('outline')
    if (item) item.checked = this.outlineVisible
  }

  showFind() {
    void this.execute('window.MW.showSearch()')
  }

  findStep(forward) {
    void this.execute(`window.MW.findStep(${Boolean(forward)})`)
  }

  find(query, forward, findNext) {
    if (!query) {
      this.findQuery = ''
      this.window.webContents.stopFindInPage('clearSelection')
      return
    }

    const continuing = Boolean(findNext && query === this.findQuery)
    this.findQuery = query
    this.window.webContents.findInPage(query, {
      forward: forward !== false,
      findNext: continuing,
    })
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => new DocumentWindow(),
        },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const parent = BrowserWindow.getFocusedWindow()
            const options = {
              title: 'Open Markdown',
              filters: [MARKDOWN_FILTER, { name: 'All files', extensions: ['*'] }],
              properties: ['openFile', 'multiSelections'],
            }
            const result = parent
              ? await dialog.showOpenDialog(parent, options)
              : await dialog.showOpenDialog(options)
            if (!result.canceled) await openPaths(result.filePaths)
          },
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => void activeDocument()?.save(),
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => void activeDocument()?.save(true),
        },
        { type: 'separator' },
        { role: 'close' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find...',
          accelerator: 'CmdOrCtrl+F',
          click: () => activeDocument()?.showFind(),
        },
        {
          label: 'Find Next',
          accelerator: 'CmdOrCtrl+G',
          click: () => activeDocument()?.findStep(true),
        },
        {
          label: 'Find Previous',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: () => activeDocument()?.findStep(false),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          id: 'outline',
          label: 'Show Document Outline',
          type: 'checkbox',
          accelerator: 'CmdOrCtrl+Alt+O',
          click: (item) => activeDocument()?.setOutline(item.checked),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Markwise',
          click: () => {
            void dialog.showMessageBox({
              title: APP_NAME,
              message: APP_NAME,
              detail: `Version ${app.getVersion()}\nA WYSIWYG Markdown viewer and editor.`,
              buttons: ['OK'],
            })
          },
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

ipcMain.on('editor-message', (event, message) => {
  if (smokeTest) {
    console.log(`Smoke: IPC ${message?.type || 'invalid'} from ${event.senderFrame?.url || 'unknown'}`)
  }
  const document = senderDocument(event)
  if (document) void document.handleMessage(message)
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  initialArguments = fileArguments(process.argv)

  app.on('second-instance', (_event, argv) => {
    void openPaths(fileArguments(argv), true)
  })

  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    if (app.isReady()) {
      void openPaths([filePath], true)
    } else {
      initialArguments.push(filePath)
    }
  })

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    buildMenu()
    if (smokeTest) {
      smokeTestTimer = setTimeout(() => {
        console.error('Markwise smoke test: editor did not become ready')
        app.exit(1)
      }, 30000)
    }
    await openPaths(initialArguments, true)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) new DocumentWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
