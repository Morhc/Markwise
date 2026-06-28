// Injected by the Rust host (WebviewWindowBuilder::initialization_script) BEFORE
// the page's own scripts run. Two jobs:
//   1. Shim window.webkit.messageHandlers.bridge so the cross-platform editor.js
//      (which targets WKWebView) works UNCHANGED on WebView2 — its postMessage
//      calls are forwarded to the Rust `bridge_message` command.
//   2. Provide a find-in-page overlay (the Windows analog of the macOS search bar),
//      driven by window.__mwFind and the Find menu items.
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupFind)
  } else {
    setupFind()
  }
})()
