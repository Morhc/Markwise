import AppKit
import WebKit

// MARK: - App entry

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()

// MARK: - Delegate

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate, NSSearchFieldDelegate {

    var window: NSWindow!
    var webView: WKWebView!

    /// Floating find-in-page bar (overlays the top-right of the web view).
    var searchBar: NSView!
    var searchField: NSSearchField!
    var matchLabel: NSTextField!

    /// Currently open file (nil = untitled).
    var currentURL: URL?
    /// Whether the editor has unsaved changes.
    var isDirty = false
    /// True once the web editor has signalled it is ready.
    var webReady = false
    /// A file requested before the editor finished loading.
    var pendingURL: URL?

    // MARK: Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        loadEditor()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    // Called when the app is asked to open files (double-click, "Open With", default handler).
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first else { return }
        if webReady {
            openFile(url)
        } else {
            pendingURL = url
        }
    }

    // MARK: Window & WebView

    func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 900, height: 720)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = "Untitled"
        window.delegate = self
        // Guard against ever restoring/shrinking to a degenerate sliver.
        window.minSize = NSSize(width: 480, height: 360)
        window.setFrameAutosaveName("MarkwiseMainWindow")
        // If a corrupt (too-small) frame was restored, reset to a sane size.
        if window.frame.width < window.minSize.width || window.frame.height < window.minSize.height {
            window.setContentSize(NSSize(width: 900, height: 720))
            window.center()
        }

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "bridge")

        webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        // Match the window background while content loads.
        webView.setValue(false, forKey: "drawsBackground")

        window.contentView = webView
        window.makeKeyAndOrderFront(nil)

        buildSearchBar()
    }

    // MARK: Find bar (floating overlay, like Safari/Chrome)

    func buildSearchBar() {
        let barW: CGFloat = 380, barH: CGFloat = 40
        // Top-right corner of the web view (AppKit origin is bottom-left).
        let x = webView.bounds.width - barW - 16
        let y = webView.bounds.height - barH - 12
        let bar = NSView(frame: NSRect(x: x, y: y, width: barW, height: barH))
        bar.wantsLayer = true
        bar.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        bar.layer?.cornerRadius = 8
        bar.layer?.borderWidth = 1
        bar.layer?.borderColor = NSColor.separatorColor.cgColor
        bar.shadow = {
            let s = NSShadow()
            s.shadowColor = NSColor.black.withAlphaComponent(0.2)
            s.shadowBlurRadius = 8
            s.shadowOffset = NSSize(width: 0, height: -2)
            return s
        }()
        // Pin to top-right as the window resizes.
        bar.autoresizingMask = [.minXMargin, .minYMargin]
        bar.isHidden = true

        searchField = NSSearchField(frame: NSRect(x: 10, y: 8, width: 230, height: 24))
        searchField.placeholderString = "Find"
        searchField.delegate = self
        searchField.sendsSearchStringImmediately = true
        searchField.target = self
        searchField.action = #selector(findNext(_:))

        let prevBtn = NSButton(frame: NSRect(x: 246, y: 8, width: 30, height: 24))
        prevBtn.title = "‹"
        prevBtn.bezelStyle = .rounded
        prevBtn.target = self
        prevBtn.action = #selector(findPrevious(_:))
        prevBtn.toolTip = "Previous (⇧⌘G)"

        let nextBtn = NSButton(frame: NSRect(x: 278, y: 8, width: 30, height: 24))
        nextBtn.title = "›"
        nextBtn.bezelStyle = .rounded
        nextBtn.target = self
        nextBtn.action = #selector(findNext(_:))
        nextBtn.toolTip = "Next (⌘G)"

        let doneBtn = NSButton(frame: NSRect(x: 314, y: 8, width: 56, height: 24))
        doneBtn.title = "Done"
        doneBtn.bezelStyle = .rounded
        doneBtn.target = self
        doneBtn.action = #selector(hideSearch)
        doneBtn.keyEquivalent = "\u{1B}" // Escape

        matchLabel = NSTextField(labelWithString: "")
        matchLabel.frame = NSRect(x: 12, y: -16, width: barW - 24, height: 14)
        matchLabel.font = .systemFont(ofSize: 10)
        matchLabel.textColor = .secondaryLabelColor
        matchLabel.isHidden = true

        bar.addSubview(searchField)
        bar.addSubview(prevBtn)
        bar.addSubview(nextBtn)
        bar.addSubview(doneBtn)

        webView.addSubview(bar)
        searchBar = bar
    }

    @objc func showSearch() {
        searchBar.isHidden = false
        window.makeFirstResponder(searchField)
        if !searchField.stringValue.isEmpty { runFind(backwards: false) }
    }

    @objc func hideSearch() {
        searchBar.isHidden = true
        // Clear any highlight in the web view.
        webView.find("", configuration: WKFindConfiguration()) { _ in }
        window.makeFirstResponder(webView)
    }

    @objc func findNext(_ sender: Any?) {
        if searchBar.isHidden { showSearch(); return }
        runFind(backwards: false)
    }

    @objc func findPrevious(_ sender: Any?) {
        if searchBar.isHidden { showSearch(); return }
        runFind(backwards: true)
    }

    func runFind(backwards: Bool) {
        let query = searchField.stringValue
        guard !query.isEmpty else { searchField.placeholderString = "Find"; return }
        let config = WKFindConfiguration()
        config.caseSensitive = false
        config.wraps = true
        config.backwards = backwards
        webView.find(query, configuration: config) { [weak self] result in
            // Visual cue: tint the field red when nothing matches.
            self?.searchField.placeholderString = result.matchFound ? "Find" : "Not found"
        }
    }

    // NSSearchFieldDelegate: live search as the user types.
    func controlTextDidChange(_ obj: Notification) {
        runFind(backwards: false)
    }

    func loadEditor() {
        guard let resourceURL = Bundle.main.resourceURL else { return }
        let webDir = resourceURL.appendingPathComponent("web", isDirectory: true)
        let indexURL = webDir.appendingPathComponent("index.html")
        webView.loadFileURL(indexURL, allowingReadAccessTo: webDir)
    }

    // MARK: Bridge (JS -> Swift)

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            webReady = true
            if let url = pendingURL {
                pendingURL = nil
                openFile(url)
            }
        case "dirty":
            setDirty(true)
        case "clean":
            setDirty(false)
        default:
            break
        }
    }

    // MARK: Document operations

    func openFile(_ url: URL) {
        do {
            let text = try String(contentsOf: url, encoding: .utf8)
            currentURL = url
            sendToEditor(open: text)
            setDirty(false)
            updateTitle()
            NSDocumentController.shared.noteNewRecentDocumentURL(url)
        } catch {
            presentError("Couldn’t open file", error.localizedDescription)
        }
    }

    /// Push markdown text into the editor.
    func sendToEditor(open text: String) {
        let data = (try? JSONEncoder().encode(text)) ?? Data("\"\"".utf8)
        let json = String(data: data, encoding: .utf8) ?? "\"\""
        let js = "window.MW.open(\(json));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    /// Pull markdown out of the editor, then run `completion` with it.
    func fetchMarkdown(_ completion: @escaping (String) -> Void) {
        webView.evaluateJavaScript("window.MW.getMarkdown()") { result, _ in
            completion((result as? String) ?? "")
        }
    }

    @objc func newDocument(_ sender: Any?) {
        // For simplicity a new doc replaces the current window's content.
        confirmDiscardIfNeeded { [weak self] proceed in
            guard let self, proceed else { return }
            self.currentURL = nil
            self.sendToEditor(open: "")
            self.setDirty(false)
            self.updateTitle()
        }
    }

    @objc func openDocument(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedFileTypes = ["md", "markdown", "mdown", "mkd", "mdwn", "mkdn", "text", "txt"]
        panel.begin { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            self.confirmDiscardIfNeeded { proceed in
                if proceed { self.openFile(url) }
            }
        }
    }

    @objc func saveDocument(_ sender: Any?) {
        if let url = currentURL {
            writeMarkdown(to: url)
        } else {
            saveDocumentAs(sender)
        }
    }

    @objc func saveDocumentAs(_ sender: Any?) {
        let panel = NSSavePanel()
        panel.allowedFileTypes = ["md", "markdown"]
        panel.nameFieldStringValue = currentURL?.lastPathComponent ?? "Untitled.md"
        panel.begin { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            self.currentURL = url
            self.writeMarkdown(to: url)
        }
    }

    func writeMarkdown(to url: URL) {
        fetchMarkdown { [weak self] md in
            guard let self else { return }
            do {
                try md.write(to: url, atomically: true, encoding: .utf8)
                self.setDirty(false)
                // Reset the editor's baseline so post-save edits are tracked correctly.
                self.webView.evaluateJavaScript("window.MW.markSaved()", completionHandler: nil)
                self.updateTitle()
                NSDocumentController.shared.noteNewRecentDocumentURL(url)
            } catch {
                self.presentError("Couldn’t save file", error.localizedDescription)
            }
        }
    }

    // MARK: Dirty state / title

    func setDirty(_ dirty: Bool) {
        isDirty = dirty
        window.isDocumentEdited = dirty
    }

    func updateTitle() {
        if let url = currentURL {
            window.title = url.lastPathComponent
            window.representedURL = url
        } else {
            window.title = "Untitled"
            window.representedURL = nil
        }
    }

    // MARK: Close / quit confirmation

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if !isDirty { return true }
        confirmDiscardIfNeeded { [weak self] proceed in
            if proceed {
                self?.isDirty = false
                self?.window.close()
            }
        }
        return false
    }

    /// If there are unsaved changes, ask the user. Calls completion(true) to proceed.
    func confirmDiscardIfNeeded(_ completion: @escaping (Bool) -> Void) {
        guard isDirty else { completion(true); return }
        let alert = NSAlert()
        alert.messageText = "Do you want to save the changes?"
        alert.informativeText = "Your changes will be lost if you don’t save them."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Don’t Save")
        alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        switch response {
        case .alertFirstButtonReturn: // Save
            if let url = currentURL {
                fetchMarkdown { [weak self] md in
                    try? md.write(to: url, atomically: true, encoding: .utf8)
                    self?.setDirty(false)
                    completion(true)
                }
            } else {
                completion(true) // Untitled: let caller proceed (Save As flow handled elsewhere)
            }
        case .alertSecondButtonReturn: // Don't Save
            completion(true)
        default: // Cancel
            completion(false)
        }
    }

    func presentError(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    // MARK: Menu

    func buildMenu() {
        let mainMenu = NSMenu()

        // App menu
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Markwise", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide Markwise", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Markwise", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // File menu
        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "File")
        fileMenuItem.submenu = fileMenu
        fileMenu.addItem(withTitle: "New", action: #selector(newDocument(_:)), keyEquivalent: "n")
        fileMenu.addItem(withTitle: "Open…", action: #selector(openDocument(_:)), keyEquivalent: "o")
        fileMenu.addItem(NSMenuItem.separator())
        fileMenu.addItem(withTitle: "Save", action: #selector(saveDocument(_:)), keyEquivalent: "s")
        let saveAs = NSMenuItem(title: "Save As…", action: #selector(saveDocumentAs(_:)), keyEquivalent: "s")
        saveAs.keyEquivalentModifierMask = [.command, .shift]
        fileMenu.addItem(saveAs)
        fileMenu.addItem(NSMenuItem.separator())
        fileMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        // Edit menu (standard responder-chain actions so the editor handles them)
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redo)
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Find…", action: #selector(showSearch), keyEquivalent: "f")
        editMenu.addItem(withTitle: "Find Next", action: #selector(findNext(_:)), keyEquivalent: "g")
        let findPrev = NSMenuItem(title: "Find Previous", action: #selector(findPrevious(_:)), keyEquivalent: "g")
        findPrev.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(findPrev)

        // View menu (zoom)
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenuItem.submenu = viewMenu
        // Full screen on ⌃⌘F so it doesn't clash with Find (⌘F).
        let fullScreen = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fullScreen)

        NSApp.mainMenu = mainMenu
    }
}
