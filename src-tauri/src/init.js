// Injected by the Rust host (WebviewWindowBuilder::initialization_script) BEFORE
// the page's own scripts run. Three jobs:
//   1. Shim window.webkit.messageHandlers.bridge so the cross-platform editor.js
//      (which targets WKWebView) works UNCHANGED on WebView2 — its postMessage
//      calls are forwarded to the Rust `bridge_message` command.
//   2. Provide a find-in-page overlay (the Windows analog of the macOS search bar),
//      driven by window.__mwFind and the Find menu items.
//   3. Provide the "change image source" prompt. macOS uses an NSAlert with an
//      accessory text field; the dialog plugin has no text-prompt API, and a Win32
//      equivalent would be a hand-rolled dialog template. Doing it in HTML here —
//      rather than in editor.js — keeps the shared web layer byte-identical to the
//      macOS branch, which is the whole point of this shim.
;(function () {
  function invoke(cmd, payload) {
    try {
      return window.__TAURI_INTERNALS__.invoke(cmd, payload)
    } catch (e) {
      return Promise.resolve()
    }
  }

  // --- 1. Bridge shim (must exist before bundle.js runs) ---
  window.webkit = window.webkit || {}
  window.webkit.messageHandlers = window.webkit.messageHandlers || {}
  window.webkit.messageHandlers.bridge = {
    postMessage: function (msg) {
      // Handled entirely on this side (see job 3). editor.js has already stashed
      // the target image position by the time it posts, so intercepting here is
      // equivalent to the host round-trip macOS does.
      if (msg && msg.type === 'editImage') {
        showImagePrompt(msg.src || '')
        return
      }
      invoke('bridge_message', { msg: msg })
    },
  }

  // --- 2. Find-in-page overlay ---
  function setupFind() {
    if (document.getElementById('mw-find')) return
    var bar = document.createElement('div')
    bar.id = 'mw-find'
    bar.style.cssText =
      'position:fixed;top:12px;right:16px;z-index:2147483647;display:none;' +
      'align-items:center;gap:6px;background:#fff;border:1px solid #ccc;' +
      'border-radius:8px;padding:6px 8px;box-shadow:0 2px 8px rgba(0,0,0,.2);' +
      'font:13px "Segoe UI",system-ui,sans-serif'

    var input = document.createElement('input')
    input.type = 'text'
    input.placeholder = 'Find'
    input.style.cssText =
      'border:1px solid #ddd;border-radius:4px;padding:3px 6px;width:180px;outline:none'

    var info = document.createElement('span')
    info.style.cssText = 'color:#888;min-width:18px;text-align:center'

    function mkbtn(t) {
      var b = document.createElement('button')
      b.textContent = t
      b.style.cssText =
        'border:1px solid #ddd;background:#f6f6f6;border-radius:4px;padding:2px 8px;cursor:pointer'
      return b
    }
    var prev = mkbtn('‹')
    var next = mkbtn('›')
    var done = mkbtn('Done')

    bar.appendChild(input)
    bar.appendChild(info)
    bar.appendChild(prev)
    bar.appendChild(next)
    bar.appendChild(done)
    document.body.appendChild(bar)

    function find(backwards) {
      var q = input.value
      if (!q) {
        info.textContent = ''
        input.style.borderColor = '#ddd'
        return
      }
      // Chromium/WebView2 native search: find(text, caseSensitive, backwards, wrap)
      var ok = window.find(q, false, !!backwards, true)
      info.textContent = ok ? '' : '0'
      input.style.borderColor = ok ? '#ddd' : '#e00'
    }

    function show() {
      bar.style.display = 'flex'
      input.focus()
      input.select()
      if (input.value) find(false)
    }
    function hide() {
      bar.style.display = 'none'
      if (window.getSelection) {
        var s = window.getSelection()
        if (s && s.removeAllRanges) s.removeAllRanges()
      }
    }

    input.addEventListener('input', function () {
      find(false)
    })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        find(e.shiftKey)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        hide()
      }
    })
    prev.addEventListener('click', function () {
      find(true)
      input.focus()
    })
    next.addEventListener('click', function () {
      find(false)
      input.focus()
    })
    done.addEventListener('click', hide)

    window.__mwFind = {
      show: show,
      hide: hide,
      next: function () {
        if (bar.style.display === 'none') show()
        else find(false)
      },
      prev: function () {
        if (bar.style.display === 'none') show()
        else find(true)
      },
    }
  }

  // --- 4. Render images referenced by a local path ---
  //
  // A .md written elsewhere can contain ![](C:\pics\a.png) or ![](./img/a.png).
  // The page is served from http://tauri.localhost, so file:// is blocked and a
  // relative path resolves against the app bundle. Tauri's asset protocol can
  // serve those files, but the rewrite has to be invisible to ProseMirror: the
  // markdown model is what getMarkdown() serializes, and if the asset URL ever
  // reached it we would write it into the user's file.
  //
  // Hooking the src setter (rather than mutating the DOM afterwards) means there
  // is no mutation for ProseMirror to notice or revert, and getAttribute keeps
  // returning what the caller wrote.
  var docDir = null
  // Called by the host on open, so relative paths resolve against the document.
  window.__mwSetDocDir = function (dir) {
    docDir = dir || null
  }

  function convertFileSrc(p) {
    try {
      return window.__TAURI_INTERNALS__.convertFileSrc(p)
    } catch (e) {
      return null
    }
  }

  // Absolute (C:\x, \\server\x, /x) vs relative (./x, img/x).
  function isAbsolutePath(p) {
    return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p) || /^\//.test(p)
  }

  function decode(s) {
    try {
      return decodeURIComponent(s)
    } catch (e) {
      return s
    }
  }

  function rewriteLocal(v) {
    if (typeof v !== 'string' || !v) return v
    // Anything already loadable, including our own asset URLs, passes through.
    if (/^(https?:|data:|blob:|asset:)/i.test(v)) return v

    var p = v
    if (/^file:\/\//i.test(p)) {
      // file:///C:/x -> C:\x     file://server/share/x -> \\server\share\x
      var body = p.replace(/^file:\/\//i, '')
      p = /^\//.test(body) ? decode(body.slice(1)) : '\\\\' + decode(body)
      p = p.replace(/\//g, '\\')
    } else if (!isAbsolutePath(p)) {
      if (!docDir) return v // unsaved document: nothing to resolve against
      p = docDir.replace(/[\\/]+$/, '') + '\\' + p.replace(/^\.[\\/]/, '').replace(/\//g, '\\')
    }
    return convertFileSrc(p) || v
  }

  var imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
  if (imgSrc && imgSrc.get && imgSrc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: imgSrc.enumerable,
      get: function () {
        return '__mwOrigSrc' in this ? this.__mwOrigSrc : imgSrc.get.call(this)
      },
      set: function (v) {
        this.__mwOrigSrc = v
        imgSrc.set.call(this, rewriteLocal(v))
      },
    })
  }

  var setAttr = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name, value) {
    if (this instanceof HTMLImageElement && String(name).toLowerCase() === 'src') {
      this.__mwOrigSrc = value
      return setAttr.call(this, name, rewriteLocal(value))
    }
    return setAttr.call(this, name, value)
  }

  var getAttr = Element.prototype.getAttribute
  Element.prototype.getAttribute = function (name) {
    if (
      this instanceof HTMLImageElement &&
      String(name).toLowerCase() === 'src' &&
      '__mwOrigSrc' in this
    ) {
      return this.__mwOrigSrc
    }
    return getAttr.call(this, name)
  }

  // --- 3. "Change image source" prompt (double-click an image) ---
  function showImagePrompt(current) {
    var back = document.createElement('div')
    back.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.25);' +
      'display:flex;align-items:center;justify-content:center;' +
      'font:13px "Segoe UI",system-ui,sans-serif'

    var card = document.createElement('div')
    card.style.cssText =
      'background:#fff;border:1px solid #ccc;border-radius:8px;padding:16px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.25);width:min(520px,80vw)'

    var label = document.createElement('div')
    label.textContent = 'Image source'
    label.style.cssText = 'margin-bottom:8px;color:#333'

    var input = document.createElement('input')
    input.type = 'text'
    input.value = current
    input.spellcheck = false
    input.style.cssText =
      'width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:4px;' +
      'padding:6px 8px;outline:none;font:inherit'

    var hint = document.createElement('div')
    hint.textContent = 'A URL, or a file on this PC (it will be embedded in the document).'
    hint.style.cssText = 'margin-top:8px;color:#888;font-size:12px'

    var row = document.createElement('div')
    row.style.cssText = 'margin-top:14px;display:flex;gap:8px;justify-content:flex-end'

    function mkbtn(t, primary) {
      var b = document.createElement('button')
      b.textContent = t
      b.style.cssText =
        'border:1px solid ' + (primary ? '#0b66c3' : '#ddd') + ';' +
        'background:' + (primary ? '#0b66c3' : '#f6f6f6') + ';' +
        'color:' + (primary ? '#fff' : '#222') + ';' +
        'border-radius:4px;padding:5px 14px;cursor:pointer;font:inherit'
      return b
    }
    var choose = mkbtn('Choose File\u2026', false)
    var cancel = mkbtn('Cancel', false)
    var save = mkbtn('Save', true)

    row.appendChild(choose)
    row.appendChild(cancel)
    row.appendChild(save)
    card.appendChild(label)
    card.appendChild(input)
    card.appendChild(hint)
    card.appendChild(row)
    back.appendChild(card)
    document.body.appendChild(back)
    input.focus()
    input.select()

    // editor.js only clears its pending image position inside setImageSrc, so a
    // dismissed prompt would leave it pointing at this image and a later reply
    // would retarget it. setImageSrc('') clears it and is otherwise a no-op.
    function close(clearPending) {
      if (back.parentNode) back.parentNode.removeChild(back)
      if (clearPending && window.MW && window.MW.setImageSrc) window.MW.setImageSrc('')
    }

    function commit() {
      var v = input.value.trim()
      if (!v) {
        close(true)
        return
      }
      if (/^(https?:|data:)/i.test(v)) {
        // Remote or already inline: hand straight to the editor.
        if (window.MW && window.MW.setImageSrc) window.MW.setImageSrc(v)
        close(false)
      } else {
        // A local path (C:\..., \\server\..., ./rel, file:///...). Unlike macOS,
        // which rewrites these to file:// and relies on WebKit's read access,
        // WebView2 refuses file:// from the app's origin — so the host reads the
        // file and replies with a data: URI.
        invoke('bridge_message', { msg: { type: 'imageFromPath', path: v } })
        close(false)
      }
    }

    save.addEventListener('click', commit)
    cancel.addEventListener('click', function () {
      close(true)
    })
    choose.addEventListener('click', function () {
      invoke('bridge_message', { msg: { type: 'chooseImage' } })
      close(false) // the host drives the rest and replies via setImageSrc
    })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        close(true)
      }
    })
    back.addEventListener('mousedown', function (e) {
      if (e.target === back) close(true)
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupFind)
  } else {
    setupFind()
  }
})()
