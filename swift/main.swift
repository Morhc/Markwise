import AppKit
import WebKit
import UniformTypeIdentifiers

// MARK: - App entry

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()

// MARK: - App delegate (application-level: menus, window set, routing)

final class AppDelegate: NSObject, NSApplicationDelegate {

    /// All open document windows (strong references keep them alive).
    var documents: [DocumentWindow] = []
    /// Where to place the next window (cascaded so they don't overlap exactly).
    var cascadePoint = NSPoint.zero
    /// Set once we've opened at least one file/window during launch.
    var didCreateInitialWindow = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        // If launched without a file to open, show one empty window.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.documents.isEmpty { self.newDocument(nil) }
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    // Files opened via double-click, "Open With", or the default handler.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { openInWindow(url) }
    }

    // MARK: Window management

    /// The frontmost document window (falls back to the most recently created).
    var activeDocument: DocumentWindow? {
        if let key = NSApp.keyWindow ?? NSApp.mainWindow {
            if let match = documents.first(where: { $0.window === key }) { return match }
        }
        return documents.last
    }

    @discardableResult
    func makeDocumentWindow() -> DocumentWindow {
        let doc = DocumentWindow(app: self)
        documents.append(doc)
        // Cascade so multiple windows don't stack exactly on top of each other.
        cascadePoint = doc.window.cascadeTopLeft(from: cascadePoint)
        doc.window.makeKeyAndOrderFront(nil)
        return doc
    }

    /// Open `url`, reusing an existing window if it's already showing that file.
    func openInWindow(_ url: URL) {
        if let existing = documents.first(where: { $0.currentURL == url }) {
            existing.window.makeKeyAndOrderFront(nil)
            return
        }
        makeDocumentWindow().requestOpen(url)
    }

    func documentDidClose(_ doc: DocumentWindow) {
        documents.removeAll { $0 === doc }
    }

    // MARK: Menu actions (app-level create new windows)

    @objc func newDocument(_ sender: Any?) {
        makeDocumentWindow()
    }

    @objc func openDocument(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = ["md", "markdown", "mdown", "mkd", "mdwn", "mkdn", "text", "txt"]
            .compactMap { UTType(filenameExtension: $0) }
        panel.begin { [weak self] response in
            guard let self, response == .OK else { return }
            for url in panel.urls { self.openInWindow(url) }
        }
    }

    // Document-specific actions forward to the active window.
    @objc func saveDocument(_ sender: Any?) { activeDocument?.save() }
    @objc func saveDocumentAs(_ sender: Any?) { activeDocument?.saveAs() }
    @objc func toggleOutline(_ sender: Any?) { activeDocument?.toggleOutline() }
    @objc func performFind(_ sender: Any?) { activeDocument?.showSearch() }
    @objc func findNext(_ sender: Any?) { activeDocument?.findNext() }
    @objc func findPrevious(_ sender: Any?) { activeDocument?.findPrevious() }

    // Disable document actions when there's no open window.
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(saveDocument(_:)), #selector(saveDocumentAs(_:)),
             #selector(performFind(_:)), #selector(findNext(_:)), #selector(findPrevious(_:)):
            return activeDocument != nil
        case #selector(toggleOutline(_:)):
            item.state = (activeDocument?.outlineVisible ?? false) ? .on : .off
            return activeDocument != nil
        default:
            return true
        }
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
        editMenu.addItem(withTitle: "Find…", action: #selector(performFind(_:)), keyEquivalent: "f")
        editMenu.addItem(withTitle: "Find Next", action: #selector(findNext(_:)), keyEquivalent: "g")
        let findPrev = NSMenuItem(title: "Find Previous", action: #selector(findPrevious(_:)), keyEquivalent: "g")
        findPrev.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(findPrev)

        // View menu
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenuItem.submenu = viewMenu
        // Document outline sidebar (off by default) on ⌥⌘O.
        let outline = NSMenuItem(title: "Show Document Outline", action: #selector(toggleOutline(_:)), keyEquivalent: "o")
        outline.keyEquivalentModifierMask = [.command, .option]
        viewMenu.addItem(outline)
        viewMenu.addItem(NSMenuItem.separator())
        // Full screen on ⌃⌘F so it doesn't clash with Find (⌘F).
        let fullScreen = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fullScreen)

        // Window menu (AppKit auto-lists open windows here for switching)
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenuItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(NSMenuItem.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }
}

// MARK: - Editor web view (intercepts image-file drops)

/// WKWebView's own drag handling doesn't reliably deliver Finder file drops to
/// the web content, so we intercept image-file drops natively and hand the
/// files to the editor as data URIs. Non-image drags fall through to WebKit.
final class EditorWebView: WKWebView {
    var onImageFilesDropped: (([URL], NSPoint) -> Bool)?
    private let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "heic"]

    private func imageURLs(_ sender: NSDraggingInfo) -> [URL] {
        let opts: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: opts) as? [URL] ?? []
        return urls.filter { imageExts.contains($0.pathExtension.lowercased()) }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        imageURLs(sender).isEmpty ? super.draggingEntered(sender) : .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        imageURLs(sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        imageURLs(sender).isEmpty ? super.prepareForDragOperation(sender) : true
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = imageURLs(sender)
        if urls.isEmpty { return super.performDragOperation(sender) }
        let point = convert(sender.draggingLocation, from: nil)
        return onImageFilesDropped?(urls, point) ?? false
    }
}

// MARK: - Document window (per-window: one file, its editor, find bar, state)

final class DocumentWindow: NSObject, WKScriptMessageHandler, WKNavigationDelegate,
                            WKUIDelegate, NSWindowDelegate, NSSearchFieldDelegate {

    weak var app: AppDelegate?

    var window: NSWindow!
    var webView: WKWebView!

    // Floating find-in-page bar.
    var searchBar: NSView!
    var searchField: NSSearchField!

    /// Currently open file (nil = untitled).
    var currentURL: URL?
    var isDirty = false
    var webReady = false
    /// Whether the document outline sidebar is showing (off by default).
    var outlineVisible = false
    /// A file requested before the editor finished loading.
    var pendingURL: URL?

    init(app: AppDelegate) {
        self.app = app
        super.init()
        buildWindow()
        loadEditor()
    }

    // MARK: Build

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
        window.isReleasedWhenClosed = false
        // Keep the window wide enough for a comfortable column plus the block
        // (+/drag) handle, and never let it shrink to a degenerate sliver.
        window.minSize = NSSize(width: 600, height: 420)

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "bridge")

        let editorWebView = EditorWebView(frame: frame, configuration: config)
        editorWebView.onImageFilesDropped = { [weak self] urls, point in
            guard let self else { return false }
            let srcs = urls.compactMap { self.fileToDataURI($0) }
            guard !srcs.isEmpty,
                  let jsonData = try? JSONSerialization.data(withJSONObject: srcs),
                  let json = String(data: jsonData, encoding: .utf8) else { return false }
            // Flip AppKit's bottom-left origin to the web's top-left origin.
            let cssX = point.x
            let cssY = self.webView.bounds.height - point.y
            self.webView.evaluateJavaScript("window.MW.insertImages(\(json), \(cssX), \(cssY))", completionHandler: nil)
            return true
        }
        webView = editorWebView
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")

        window.contentView = webView

        buildSearchBar()
    }

    func loadEditor() {
        guard let resourceURL = Bundle.main.resourceURL else { return }
        let webDir = resourceURL.appendingPathComponent("web", isDirectory: true)
        let indexURL = webDir.appendingPathComponent("index.html")
        // Grant read access to the whole filesystem so local images referenced
        // by absolute/`file://` paths (e.g. ~/pictures) actually render. This is
        // a local, unsigned personal app with no remote content, so the broad
        // scope is acceptable.
        webView.loadFileURL(indexURL, allowingReadAccessTo: URL(fileURLWithPath: "/"))
    }

    /// Ask this window to open a file once its editor is ready.
    func requestOpen(_ url: URL) {
        if webReady { openFile(url) } else { pendingURL = url }
    }

    // MARK: Find bar (floating overlay, like Safari/Chrome)

    func buildSearchBar() {
        let barW: CGFloat = 380, barH: CGFloat = 40
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
        bar.autoresizingMask = [.minXMargin, .minYMargin]
        bar.isHidden = true

        searchField = NSSearchField(frame: NSRect(x: 10, y: 8, width: 230, height: 24))
        searchField.placeholderString = "Find"
        searchField.delegate = self
        searchField.sendsSearchStringImmediately = true
        searchField.target = self
        searchField.action = #selector(findNextAction(_:))

        let prevBtn = NSButton(frame: NSRect(x: 246, y: 8, width: 30, height: 24))
        prevBtn.title = "‹"
        prevBtn.bezelStyle = .rounded
        prevBtn.target = self
        prevBtn.action = #selector(findPreviousAction(_:))
        prevBtn.toolTip = "Previous (⇧⌘G)"

        let nextBtn = NSButton(frame: NSRect(x: 278, y: 8, width: 30, height: 24))
        nextBtn.title = "›"
        nextBtn.bezelStyle = .rounded
        nextBtn.target = self
        nextBtn.action = #selector(findNextAction(_:))
        nextBtn.toolTip = "Next (⌘G)"

        let doneBtn = NSButton(frame: NSRect(x: 314, y: 8, width: 56, height: 24))
        doneBtn.title = "Done"
        doneBtn.bezelStyle = .rounded
        doneBtn.target = self
        doneBtn.action = #selector(hideSearch)
        doneBtn.keyEquivalent = "\u{1B}" // Escape

        bar.addSubview(searchField)
        bar.addSubview(prevBtn)
        bar.addSubview(nextBtn)
        bar.addSubview(doneBtn)

        webView.addSubview(bar)
        searchBar = bar
    }

    // MARK: Outline

    func toggleOutline() {
        outlineVisible.toggle()
        webView.evaluateJavaScript("window.MW.setOutline(\(outlineVisible))", completionHandler: nil)
    }

    func showSearch() {
        searchBar.isHidden = false
        window.makeFirstResponder(searchField)
        if !searchField.stringValue.isEmpty { runFind(backwards: false) }
    }

    @objc func hideSearch() {
        searchBar.isHidden = true
        webView.find("", configuration: WKFindConfiguration()) { _ in }
        window.makeFirstResponder(webView)
    }

    func findNext() {
        if searchBar.isHidden { showSearch(); return }
        runFind(backwards: false)
    }

    func findPrevious() {
        if searchBar.isHidden { showSearch(); return }
        runFind(backwards: true)
    }

    // Local button/field targets.
    @objc func findNextAction(_ sender: Any?) { findNext() }
    @objc func findPreviousAction(_ sender: Any?) { findPrevious() }

    func runFind(backwards: Bool) {
        let query = searchField.stringValue
        guard !query.isEmpty else { searchField.placeholderString = "Find"; return }
        let config = WKFindConfiguration()
        config.caseSensitive = false
        config.wraps = true
        config.backwards = backwards
        webView.find(query, configuration: config) { [weak self] result in
            self?.searchField.placeholderString = result.matchFound ? "Find" : "Not found"
        }
    }

    func controlTextDidChange(_ obj: Notification) {
        runFind(backwards: false)
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
        case "openLink":
            if let href = body["href"] as? String { openExternal(href) }
        case "editImage":
            editImageSource(current: body["src"] as? String ?? "")
        default:
            break
        }
    }

    /// Open an http(s)/mailto link in the user's default browser/handler.
    func openExternal(_ href: String) {
        guard let url = URL(string: href), let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: Image source editing (double-click an image)

    /// Prompt to change an image's source: edit the text, or pick a file.
    func editImageSource(current: String) {
        let alert = NSAlert()
        alert.messageText = "Edit image source"
        alert.informativeText = "Enter an image URL or file path, or choose a file."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 340, height: 24))
        field.stringValue = current
        field.lineBreakMode = .byTruncatingHead
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")          // .alertFirstButtonReturn
        alert.addButton(withTitle: "Choose File…")   // .alertSecondButtonReturn
        alert.addButton(withTitle: "Cancel")         // .alertThirdButtonReturn
        alert.window.initialFirstResponder = field
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            applyImageSource(normalizedImageSrc(field.stringValue))
        case .alertSecondButtonReturn:
            chooseImageFile()
        default:
            break
        }
    }

    func chooseImageFile() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "heic"]
            .compactMap { UTType(filenameExtension: $0) }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            self.applyImageSource(url.absoluteString)
        }
    }

    /// Turn a bare/`~` path into a proper file URL; pass URLs through unchanged.
    func normalizedImageSrc(_ raw: String) -> String {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return s }
        let lower = s.lowercased()
        for scheme in ["http://", "https://", "file://", "data:"] where lower.hasPrefix(scheme) {
            return s
        }
        var path = s
        if path.hasPrefix("~") { path = (path as NSString).expandingTildeInPath }
        if path.hasPrefix("/") { return URL(fileURLWithPath: path).absoluteString }
        return s
    }

    /// Read an image file into a self-contained data: URL for embedding.
    func fileToDataURI(_ url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let mime: String
        switch url.pathExtension.lowercased() {
        case "png": mime = "image/png"
        case "jpg", "jpeg": mime = "image/jpeg"
        case "gif": mime = "image/gif"
        case "webp": mime = "image/webp"
        case "svg": mime = "image/svg+xml"
        case "bmp": mime = "image/bmp"
        case "tiff", "tif": mime = "image/tiff"
        case "heic": mime = "image/heic"
        default: mime = "application/octet-stream"
        }
        return "data:\(mime);base64,\(data.base64EncodedString())"
    }

    func applyImageSource(_ src: String) {
        let data = (try? JSONEncoder().encode(src)) ?? Data("\"\"".utf8)
        let json = String(data: data, encoding: .utf8) ?? "\"\""
        webView.evaluateJavaScript("window.MW.setImageSrc(\(json))", completionHandler: nil)
    }

    // MARK: Navigation (open external links outside the WebView)

    // Catches clicks on real <a href> links (e.g. the URL shown in the link
    // tooltip, which uses target="_blank"). Local file navigations are allowed;
    // external links open in the default browser instead of inside the editor.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, !url.isFileURL,
           let scheme = url.scheme?.lowercased(),
           ["http", "https", "mailto"].contains(scheme) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // target="_blank" links ask WebKit to create a new web view; route them to
    // the browser instead of silently dropping them.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
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

    func sendToEditor(open text: String) {
        let data = (try? JSONEncoder().encode(text)) ?? Data("\"\"".utf8)
        let json = String(data: data, encoding: .utf8) ?? "\"\""
        webView.evaluateJavaScript("window.MW.open(\(json));", completionHandler: nil)
    }

    func fetchMarkdown(_ completion: @escaping (String) -> Void) {
        webView.evaluateJavaScript("window.MW.getMarkdown()") { result, _ in
            completion((result as? String) ?? "")
        }
    }

    func save() {
        if let url = currentURL { writeMarkdown(to: url) } else { saveAs() }
    }

    func saveAs() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = ["md", "markdown"]
            .compactMap { UTType(filenameExtension: $0) }
        panel.nameFieldStringValue = currentURL?.lastPathComponent ?? "Untitled.md"
        panel.beginSheetModal(for: window) { [weak self] response in
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

    // MARK: Close confirmation

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

    func windowWillClose(_ notification: Notification) {
        app?.documentDidClose(self)
    }

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
        case .alertFirstButtonReturn:
            if let url = currentURL {
                fetchMarkdown { [weak self] md in
                    try? md.write(to: url, atomically: true, encoding: .utf8)
                    self?.setDirty(false)
                    completion(true)
                }
            } else {
                completion(true)
            }
        case .alertSecondButtonReturn:
            completion(true)
        default:
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
}
