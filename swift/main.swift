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

    /// A window created at launch, before we know whether a file is coming.
    ///
    /// Loading the page is the slow part of starting up - most of it is WebKit
    /// spawning its content process - and it used to begin only once the
    /// open-file event had been delivered and the window built, so none of it
    /// overlapped. Starting it here runs that work alongside the rest of launch;
    /// whichever document turns up first claims this window.
    var prewarmedWindow: DocumentWindow?

    func applicationWillFinishLaunching(_ notification: Notification) {
        prewarmedWindow = makeDocumentWindow(expectsDocument: true)
    }

    /// Take the pre-warmed window if it's still going spare.
    func claimPrewarmedWindow() -> DocumentWindow? {
        guard let warm = prewarmedWindow, warm.currentURL == nil, warm.pendingURL == nil else { return nil }
        prewarmedWindow = nil
        return warm
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // WebKit reads its continuous-spell-check state from this default, but
        // only from the persistent domain - a `register(defaults:)` fallback is
        // ignored. Seed it just once, so spell checking is on out of the box and
        // a later toggle from Edit ▸ Spelling still wins.
        let spellKey = "WebContinuousSpellCheckingEnabled"
        if UserDefaults.standard.object(forKey: spellKey) == nil {
            UserDefaults.standard.set(true, forKey: spellKey)
        }
        applyAppearance()
        buildMenu()
        installFormatKeyMonitor()
        // Nothing to open: the window waiting at launch becomes the empty one.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let warm = self.claimPrewarmedWindow() { warm.openEmptyDocument() }
            else if self.documents.isEmpty { self.newDocument(nil) }
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    /// Quitting shouldn't throw away work any more than closing a window does.
    ///
    /// Saving can involve a sheet (an untitled document needs a destination) and
    /// the editor answers asynchronously, so the decision can't be made inline:
    /// the reply comes back through `NSApp.reply(toApplicationShouldTerminate:)`.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let unsaved = documents.filter { $0.isDirty }
        guard !unsaved.isEmpty else { return .terminateNow }

        // With several documents outstanding, offer the usual macOS shortcut of
        // discarding the lot rather than walking through every one.
        if unsaved.count > 1 {
            let alert = NSAlert()
            alert.messageText = "You have unsaved changes in \(unsaved.count) documents."
            alert.informativeText = "Do you want to review them before quitting?"
            alert.addButton(withTitle: "Review Changes…")
            alert.addButton(withTitle: "Discard Changes")
            alert.addButton(withTitle: "Cancel")
            switch alert.runModal() {
            case .alertFirstButtonReturn: break
            case .alertSecondButtonReturn: return .terminateNow
            default: return .terminateCancel
            }
        }

        reviewUnsaved(Array(unsaved))
        return .terminateLater
    }

    /// Walk the unsaved documents one at a time; cancelling any one calls the
    /// whole quit off, leaving the rest untouched.
    private func reviewUnsaved(_ remaining: [DocumentWindow]) {
        var rest = remaining
        guard !rest.isEmpty else {
            NSApp.reply(toApplicationShouldTerminate: true)
            return
        }
        let doc = rest.removeFirst()
        doc.confirmDiscardIfNeeded { [weak self] proceed in
            guard proceed else {
                NSApp.reply(toApplicationShouldTerminate: false)
                return
            }
            self?.reviewUnsaved(rest)
        }
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
    func makeDocumentWindow(openURL: URL? = nil, expectsDocument: Bool = false) -> DocumentWindow {
        let doc = DocumentWindow(app: self, openURL: openURL, expectsDocument: expectsDocument)
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
        if let warm = claimPrewarmedWindow() {
            warm.requestOpen(url) // already loading; hand it the file
            return
        }
        // Hand the URL over at construction so the page knows a document is
        // coming before it boots, and builds its editor once rather than twice.
        makeDocumentWindow(openURL: url)
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
    @objc func exportPDF(_ sender: Any?) { activeDocument?.exportPDF() }
    @objc func toggleOutline(_ sender: Any?) { activeDocument?.toggleOutline() }
    @objc func toggleSourceView(_ sender: Any?) { activeDocument?.toggleSourceView() }
    @objc func reloadFromDisk(_ sender: Any?) { activeDocument?.reloadFromDisk() }
    @objc func showInFinder(_ sender: Any?) { activeDocument?.showInFinder() }
    @objc func performFind(_ sender: Any?) { activeDocument?.showSearch() }
    @objc func findNext(_ sender: Any?) { activeDocument?.findNext() }
    @objc func findPrevious(_ sender: Any?) { activeDocument?.findPrevious() }
    @objc func toggleSuperscript(_ sender: Any?) { activeDocument?.toggleMark("sup") }
    @objc func toggleSubscript(_ sender: Any?) { activeDocument?.toggleMark("sub") }

    // Disable document actions when there's no open window.
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(saveDocument(_:)), #selector(saveDocumentAs(_:)), #selector(exportPDF(_:)),
             #selector(performFind(_:)), #selector(findNext(_:)), #selector(findPrevious(_:)):
            return activeDocument != nil
        case #selector(toggleSuperscript(_:)), #selector(toggleSubscript(_:)):
            // Formatting applies to the rendered document, not the raw source.
            return activeDocument != nil && !(activeDocument?.sourceVisible ?? false)
        case #selector(reloadFromDisk(_:)), #selector(showInFinder(_:)):
            // An untitled document has no file to reload from or reveal.
            return activeDocument?.currentURL != nil
        case #selector(toggleOutline(_:)):
            item.state = (activeDocument?.outlineVisible ?? false) ? .on : .off
            return activeDocument != nil
        case #selector(toggleSourceView(_:)):
            item.state = (activeDocument?.sourceVisible ?? false) ? .on : .off
            return activeDocument != nil
        case #selector(useSystemAppearance(_:)):
            item.state = appearancePreference == "system" ? .on : .off
            return true
        case #selector(useLightAppearance(_:)):
            item.state = appearancePreference == "light" ? .on : .off
            return true
        case #selector(useDarkAppearance(_:)):
            item.state = appearancePreference == "dark" ? .on : .off
            return true
        default:
            return true
        }
    }

    // MARK: Appearance

    static let appearanceKey = "MWAppearance"

    /// "system", "light" or "dark".
    var appearancePreference: String {
        UserDefaults.standard.string(forKey: AppDelegate.appearanceKey) ?? "system"
    }

    /// Setting the application's appearance is all that's needed: the window
    /// chrome follows it, and WebKit reports it to the page as
    /// `prefers-color-scheme`, which is what the editor's dark palette keys off.
    /// A nil appearance means "whatever the system is doing".
    func applyAppearance() {
        switch appearancePreference {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: NSApp.appearance = nil
        }
    }

    func setAppearance(_ value: String) {
        UserDefaults.standard.set(value, forKey: AppDelegate.appearanceKey)
        applyAppearance()
    }

    @objc func useSystemAppearance(_ sender: Any?) { setAppearance("system") }
    @objc func useLightAppearance(_ sender: Any?) { setAppearance("light") }
    @objc func useDarkAppearance(_ sender: Any?) { setAppearance("dark") }

    /// Catch the super/subscript shortcuts ourselves.
    ///
    /// ⌃⌘+ has to be typed as ⌃⌘⇧= on most layouts, and AppKit's key-equivalent
    /// matching won't accept a shifted punctuation key equivalent however the
    /// modifier mask is written - the menu item fires from the menu but never
    /// from the keyboard. Matching the key here accepts the shifted and
    /// unshifted forms of both shortcuts, so ⌃⌘+ and ⌃⌘= are equally fine.
    func installFormatKeyMonitor() {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard flags.contains(.command), flags.contains(.control), !flags.contains(.option),
                  let doc = self?.activeDocument, !doc.sourceVisible
            else { return event }

            switch event.charactersIgnoringModifiers {
            case "+", "=":
                doc.toggleMark("sup")
                return nil
            case "_", "-":
                doc.toggleMark("sub")
                return nil
            default:
                return event
            }
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
        let exportPDFItem = NSMenuItem(title: "Export as PDF…", action: #selector(exportPDF(_:)), keyEquivalent: "e")
        exportPDFItem.keyEquivalentModifierMask = [.command, .shift]
        fileMenu.addItem(exportPDFItem)
        fileMenu.addItem(NSMenuItem.separator())
        // Pick up edits made to the file by another program.
        fileMenu.addItem(withTitle: "Reload from Disk", action: #selector(reloadFromDisk(_:)), keyEquivalent: "r")
        // ⌥⌘R, the same shortcut VS Code uses for Reveal in Finder (⌘R is taken).
        let reveal = NSMenuItem(title: "Show in Finder", action: #selector(showInFinder(_:)), keyEquivalent: "r")
        reveal.keyEquivalentModifierMask = [.command, .option]
        fileMenu.addItem(reveal)
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

        // Spelling: WKWebView implements these standard responder-chain actions,
        // so the system spell checker works with no extra wiring.
        editMenu.addItem(NSMenuItem.separator())
        let spellingItem = NSMenuItem(title: "Spelling and Grammar", action: nil, keyEquivalent: "")
        let spellingMenu = NSMenu(title: "Spelling and Grammar")
        spellingItem.submenu = spellingMenu
        spellingMenu.addItem(withTitle: "Show Spelling and Grammar",
                             action: Selector(("showGuessPanel:")), keyEquivalent: ":")
        spellingMenu.addItem(withTitle: "Check Document Now",
                             action: Selector(("checkSpelling:")), keyEquivalent: ";")
        spellingMenu.addItem(NSMenuItem.separator())
        spellingMenu.addItem(withTitle: "Check Spelling While Typing",
                             action: Selector(("toggleContinuousSpellChecking:")), keyEquivalent: "")
        spellingMenu.addItem(withTitle: "Check Grammar With Spelling",
                             action: Selector(("toggleGrammarChecking:")), keyEquivalent: "")
        spellingMenu.addItem(withTitle: "Correct Spelling Automatically",
                             action: Selector(("toggleAutomaticSpellingCorrection:")), keyEquivalent: "")
        editMenu.addItem(spellingItem)

        // Format menu - markdown has no superscript/subscript syntax, so these
        // write the HTML tags that GitHub, Pandoc and Typora all understand.
        let formatMenuItem = NSMenuItem()
        mainMenu.addItem(formatMenuItem)
        let formatMenu = NSMenu(title: "Format")
        formatMenuItem.submenu = formatMenu
        // Shown as ⌃⌘+, matching Pages. AppKit won't actually match a shifted
        // punctuation key equivalent here whichever way the mask is written, so
        // the key handling is done by the monitor in `installFormatKeyMonitor`;
        // this key equivalent is for display. Subscript needs no Shift and
        // matches on its own.
        let superscript = NSMenuItem(title: "Superscript", action: #selector(toggleSuperscript(_:)), keyEquivalent: "+")
        superscript.keyEquivalentModifierMask = [.command, .control]
        formatMenu.addItem(superscript)
        let subscriptItem = NSMenuItem(title: "Subscript", action: #selector(toggleSubscript(_:)), keyEquivalent: "-")
        subscriptItem.keyEquivalentModifierMask = [.command, .control]
        formatMenu.addItem(subscriptItem)

        // View menu
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenuItem.submenu = viewMenu
        // Document outline sidebar (off by default) on ⌥⌘O.
        let outline = NSMenuItem(title: "Show Document Outline", action: #selector(toggleOutline(_:)), keyEquivalent: "o")
        outline.keyEquivalentModifierMask = [.command, .option]
        viewMenu.addItem(outline)
        // Raw markdown, editable, on ⌘/.
        viewMenu.addItem(withTitle: "Show Markdown Source", action: #selector(toggleSourceView(_:)), keyEquivalent: "/")
        viewMenu.addItem(NSMenuItem.separator())

        // Appearance: follow the system by default, or pin light/dark.
        let appearanceItem = NSMenuItem(title: "Appearance", action: nil, keyEquivalent: "")
        let appearanceMenu = NSMenu(title: "Appearance")
        appearanceItem.submenu = appearanceMenu
        appearanceMenu.addItem(withTitle: "Match System", action: #selector(useSystemAppearance(_:)), keyEquivalent: "")
        appearanceMenu.addItem(withTitle: "Light", action: #selector(useLightAppearance(_:)), keyEquivalent: "")
        appearanceMenu.addItem(withTitle: "Dark", action: #selector(useDarkAppearance(_:)), keyEquivalent: "")
        viewMenu.addItem(appearanceItem)
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
    var isExportingPDF = false
    /// Whether the document outline sidebar is showing (off by default).
    var outlineVisible = false
    /// Whether the raw-markdown source view is showing (off by default).
    var sourceVisible = false
    /// A file requested before the editor finished loading.
    var pendingURL: URL?
    /// The file's modification date when we last read or wrote it, so we can
    /// tell "changed on disk" apart from "unchanged".
    var lastKnownModification: Date?
    /// The text as last read or written - the common ancestor for a three-way
    /// merge when the file and the editor have both moved on.
    var lastSyncedText: String?
    /// Whether a document is expected, so the page shouldn't build an empty
    /// editor it would only have to throw away.
    var expectsDocument = false
    /// Set when nothing turned up and the window should just show a blank document.
    var wantsEmptyDocument = false

    init(app: AppDelegate, openURL: URL? = nil, expectsDocument: Bool = false) {
        self.app = app
        // Set before the page loads: the editor checks it to decide whether to
        // build an empty document, which it would only have to throw away.
        self.pendingURL = openURL
        self.expectsDocument = expectsDocument || openURL != nil
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
        if expectsDocument {
            // Runs before the bundle does, so the editor can skip building an
            // empty document it is about to replace.
            config.userContentController.addUserScript(WKUserScript(
                source: "window.MW_PENDING_DOC = true",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }

        let editorWebView = EditorWebView(frame: frame, configuration: config)
        editorWebView.onImageFilesDropped = { [weak self] urls, point in
            guard let self else { return false }
            // Copy each dropped file next to the document and reference it
            // relatively; embed it only when there's no document folder yet.
            let srcs: [String] = urls.compactMap { url in
                guard let data = try? Data(contentsOf: url) else { return nil }
                if let docURL = self.currentURL,
                   let rel = self.writeImage(data,
                                             preferredName: url.lastPathComponent,
                                             fallbackExt: url.pathExtension.isEmpty ? "png" : url.pathExtension,
                                             beside: docURL) {
                    return rel
                }
                return self.fileToDataURI(url)
            }
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

    /// Ask this window to open a file, now or once its editor is ready.
    func requestOpen(_ url: URL) {
        if webReady { openFile(url) } else { pendingURL = url }
    }

    /// Nothing is coming - show an empty document instead.
    func openEmptyDocument() {
        if webReady { sendToEditor(open: "") } else { wantsEmptyDocument = true }
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

    // MARK: Source view

    func toggleSourceView() {
        sourceVisible.toggle()
        webView.evaluateJavaScript("window.MW.setSource(\(sourceVisible))", completionHandler: nil)
    }

    /// Toggle an inline mark (superscript/subscript) over the selection.
    func toggleMark(_ name: String) {
        webView.evaluateJavaScript("window.MW.toggleMark(\(jsString(name)))", completionHandler: nil)
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
            applySpellCheckingPreference()
            if let url = pendingURL {
                pendingURL = nil
                openFile(url)
            } else if wantsEmptyDocument {
                wantsEmptyDocument = false
                sendToEditor(open: "")
            }
        case "opened":
            refreshSpellCheckingMarks()
        case "dirty":
            setDirty(true)
        case "clean":
            setDirty(false)
        case "openLink":
            if let href = body["href"] as? String { openExternal(href) }
        case "editImage":
            editImageSource(current: body["src"] as? String ?? "")
        case "saveImage":
            saveImageBeside(id: body["id"] as? Int ?? 0,
                            dataURL: body["data"] as? String,
                            remote: body["url"] as? String,
                            suggestedName: body["name"] as? String)
        default:
            break
        }
    }

    /// Turn continuous spell checking on to match the stored preference.
    ///
    /// WebKit writes `WebContinuousSpellCheckingEnabled` when the Edit ▸ Spelling
    /// item is toggled, but it doesn't *start* from that key - a fresh web view
    /// comes up with checking off regardless. So ask the web view what state it
    /// is in and send it the same action the menu would if it disagrees. The
    /// state is process-wide, so whichever window loads first settles it.
    static let spellCheckKey = "WebContinuousSpellCheckingEnabled"

    func applySpellCheckingPreference() {
        guard UserDefaults.standard.bool(forKey: DocumentWindow.spellCheckKey) else { return }
        let toggle = Selector(("toggleContinuousSpellChecking:"))
        let probe = NSMenuItem(title: "", action: toggle, keyEquivalent: "")
        if let validator = webView as? NSUserInterfaceValidations,
           validator.validateUserInterfaceItem(probe), probe.state == .off {
            NSApp.sendAction(toggle, to: webView, from: nil)
        }
    }

    /// Get the whole document marked for misspellings, not just the paragraph
    /// the caret happens to be in.
    ///
    /// WebKit checks a block when the caret enters it and offers no way to check
    /// a document outright (toggling continuous checking doesn't rescan loaded
    /// text). The editor walks the caret across every block to provoke it.
    func refreshSpellCheckingMarks() {
        guard UserDefaults.standard.bool(forKey: DocumentWindow.spellCheckKey) else { return }
        webView.evaluateJavaScript("window.MW.primeSpellCheck()", completionHandler: nil)
    }

    /// Open an http(s)/mailto link in the user's default browser/handler.
    func openExternal(_ href: String) {
        guard let url = URL(string: href), let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: Saving images beside the document

    /// Folder that images pasted or dropped into this document are written to.
    static let imageFolderName = "images"

    /// Write an image next to the document and answer with a path relative to
    /// it, so the markdown stays portable (`images/foo.png`) instead of carrying
    /// a base64 blob or depending on a remote server.
    ///
    /// Answers `null` when there's nowhere to put the file - an unsaved document
    /// has no folder of its own - and the editor then keeps whatever it had.
    func saveImageBeside(id: Int, dataURL: String?, remote: String?, suggestedName: String?) {
        guard let docURL = currentURL else { return replyToEditor(id: id, value: nil) }

        if let dataURL, let (data, ext) = decodeDataURL(dataURL) {
            let name = suggestedName ?? "image.\(ext)"
            replyToEditor(id: id, value: writeImage(data, preferredName: name, fallbackExt: ext, beside: docURL))
            return
        }

        guard let remote, let url = URL(string: remote),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https"
        else { return replyToEditor(id: id, value: nil) }

        // Pasting an image copied from a web page is the one thing that reaches
        // the network, and only because the user asked for that image.
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            let mime = (response as? HTTPURLResponse)?.mimeType ?? response?.mimeType ?? ""
            // Cap it so a mis-click can't drop a huge file into the user's folder.
            guard let data, !data.isEmpty, data.count <= 40 * 1024 * 1024, mime.hasPrefix("image/") else {
                DispatchQueue.main.async { self.replyToEditor(id: id, value: nil) }
                return
            }
            let ext = Self.extensionFor(mime: mime) ?? (url.pathExtension.isEmpty ? "png" : url.pathExtension)
            let name = url.lastPathComponent.isEmpty ? "image.\(ext)" : url.lastPathComponent
            DispatchQueue.main.async {
                let path = self.writeImage(data, preferredName: name, fallbackExt: ext, beside: docURL)
                self.replyToEditor(id: id, value: path)
            }
        }.resume()
    }

    /// Write `data` into the document's images folder under a safe, unique name.
    /// Returns the path relative to the document, or nil if it couldn't be written.
    func writeImage(_ data: Data, preferredName: String, fallbackExt: String, beside docURL: URL) -> String? {
        let folder = docURL.deletingLastPathComponent().appendingPathComponent(Self.imageFolderName, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            return nil
        }

        var ext = (preferredName as NSString).pathExtension.lowercased()
        if ext.isEmpty { ext = fallbackExt }
        var stem = Self.sanitize((preferredName as NSString).deletingPathExtension)
        if stem.isEmpty { stem = Self.sanitize(docURL.deletingPathExtension().lastPathComponent) + "-image" }

        // Never overwrite an existing file; walk a suffix until the name is free.
        var candidate = "\(stem).\(ext)"
        var n = 1
        while FileManager.default.fileExists(atPath: folder.appendingPathComponent(candidate).path) {
            candidate = "\(stem)-\(n).\(ext)"
            n += 1
        }

        do {
            try data.write(to: folder.appendingPathComponent(candidate), options: .atomic)
        } catch {
            return nil
        }
        return "\(Self.imageFolderName)/\(candidate)"
    }

    /// Reduce a name to characters that need no escaping in a markdown path.
    static func sanitize(_ raw: String) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        let mapped = raw.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        // Collapse runs of "-" and trim them from the ends.
        let collapsed = String(mapped).split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
        return String(collapsed.prefix(60))
    }

    static func extensionFor(mime: String) -> String? {
        switch mime.lowercased() {
        case "image/png": return "png"
        case "image/jpeg", "image/jpg": return "jpg"
        case "image/gif": return "gif"
        case "image/webp": return "webp"
        case "image/svg+xml": return "svg"
        case "image/bmp": return "bmp"
        case "image/tiff": return "tiff"
        case "image/heic": return "heic"
        default: return nil
        }
    }

    /// Split a `data:image/png;base64,…` URL into its bytes and file extension.
    func decodeDataURL(_ s: String) -> (Data, String)? {
        guard s.hasPrefix("data:"), let comma = s.firstIndex(of: ",") else { return nil }
        let header = String(s[s.index(s.startIndex, offsetBy: 5)..<comma])
        guard header.contains("base64") else { return nil }
        let mime = header.split(separator: ";").first.map(String.init) ?? ""
        guard mime.hasPrefix("image/"),
              let data = Data(base64Encoded: String(s[s.index(after: comma)...]))
        else { return nil }
        return (data, Self.extensionFor(mime: mime) ?? "png")
    }

    /// Answer a `requestNative` call in the editor.
    func replyToEditor(id: Int, value: String?) {
        let arg = value.map { jsString($0) } ?? "null"
        webView.evaluateJavaScript("window.MW.nativeReply(\(id), \(arg))", completionHandler: nil)
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
            lastKnownModification = modificationDate(of: url)
            lastSyncedText = text
            sendToEditor(open: text)
            setDirty(false)
            updateTitle()
            NSDocumentController.shared.noteNewRecentDocumentURL(url)
        } catch {
            presentError("Couldn’t open file", error.localizedDescription)
            // The page skips building an empty editor when a document is on its
            // way, so give it one now or the window stays blank.
            sendToEditor(open: "")
        }
    }

    /// JSON-encode a string for safe interpolation into a JS call.
    func jsString(_ s: String) -> String {
        let data = (try? JSONEncoder().encode(s)) ?? Data("\"\"".utf8)
        return String(data: data, encoding: .utf8) ?? "\"\""
    }

    func sendToEditor(open text: String) {
        // Hand over the file's own directory too, so images written as paths
        // relative to the document resolve against it rather than against the
        // app bundle's web/ folder.
        let base = currentURL.map { jsString($0.deletingLastPathComponent().absoluteString) } ?? "null"
        webView.evaluateJavaScript("window.MW.open(\(jsString(text)), \(base));", completionHandler: nil)
    }

    func updateDocumentBase(for documentURL: URL?) {
        let base = documentURL.map { jsString($0.deletingLastPathComponent().absoluteString) } ?? "null"
        webView.evaluateJavaScript("window.MW.setBaseURL(\(base))", completionHandler: nil)
    }

    func fetchMarkdown(_ completion: @escaping (String) -> Void) {
        webView.evaluateJavaScript("window.MW.getMarkdown()") { result, _ in
            completion((result as? String) ?? "")
        }
    }

    /// The file's current modification date, if it still exists.
    func modificationDate(of url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }

    /// Whether the file changed on disk since we last read or wrote it.
    var changedOnDisk: Bool {
        guard let url = currentURL, let now = modificationDate(of: url) else { return false }
        guard let known = lastKnownModification else { return false }
        return now > known
    }

    /// Reveal the document in Finder.
    func showInFinder() {
        guard let url = currentURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    /// Re-read the file, picking up edits made outside Markwise.
    ///
    /// Three cases, and they deserve different answers: nothing changed either
    /// side (say so rather than silently doing nothing), the file moved on but
    /// the editor is clean (just reload), or both changed - a real conflict,
    /// where the only thing at stake is which version survives.
    func reloadFromDisk() {
        guard let url = currentURL else { return }
        let external = changedOnDisk

        if isDirty {
            guard external else {
                // Nothing has changed underneath us, so there's nothing to
                // reload and no reason to throw the edits away: save them.
                // Reload can always keep your work when keeping it is safe.
                writeMarkdown(to: url)
                return
            }
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "“\(url.lastPathComponent)” was changed by another program."
            alert.informativeText = "You have unsaved changes here too. Merging combines them into this one file, marking up only the places where the two versions changed the same lines."
            alert.addButton(withTitle: "Merge Both")
            alert.addButton(withTitle: "Reload from Disk")
            alert.addButton(withTitle: "Keep My Version")
            alert.addButton(withTitle: "Cancel")
            switch alert.runModal() {
            case .alertFirstButtonReturn:
                mergeWithDiskVersion(url)
                return
            case .alertSecondButtonReturn:
                break // fall through to reload
            case .alertThirdButtonReturn:
                writeMarkdown(to: url)
                return
            default:
                return
            }
        } else if !external {
            let alert = NSAlert()
            alert.messageText = "“\(url.lastPathComponent)” is already up to date."
            alert.informativeText = "The file hasn't changed on disk since you opened it."
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return
        }

        openFile(url)
    }

    // MARK: Merging both versions

    // Conflict markers have to survive a round trip through a markdown editor,
    // and git's don't: `=======` is a setext heading underline (it comes back
    // escaped as `\=======`) and `>>>>>>>` is seven nested blockquotes. A line
    // starting `<<<<<<<` is inert in commonmark, so all three markers use it.
    static let conflictMine = "MARKWISE CONFLICT: YOUR VERSION (unsaved)"
    static let conflictTheirs = "MARKWISE CONFLICT: ON DISK (changed by another program)"
    static let conflictEnd = "MARKWISE CONFLICT: END OF CONFLICT"

    /// Combine both versions into the one file.
    ///
    /// A three-way merge against the text as it was opened, so edits that don't
    /// overlap simply come out combined and only genuinely competing lines are
    /// marked up for the user to settle.
    func mergeWithDiskVersion(_ url: URL) {
        guard let diskText = try? String(contentsOf: url, encoding: .utf8) else {
            presentError("Couldn’t merge", "The file could no longer be read.")
            return
        }
        let base = lastSyncedText ?? ""
        let js = "JSON.stringify(window.MW.mergeInputs(\(jsString(base)), \(jsString(diskText))))"
        webView.evaluateJavaScript(js) { [weak self] result, _ in
            guard let self else { return }
            guard let json = result as? String,
                  let data = json.data(using: .utf8),
                  let sides = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
                  let mine = sides["mine"], let ancestor = sides["base"], let theirs = sides["theirs"]
            else {
                self.presentError("Couldn’t merge", "The editor didn’t return its version of the document.")
                return
            }
            self.applyMerge(url: url, ancestor: ancestor, mine: mine, theirs: theirs)
        }
    }

    private func applyMerge(url: URL, ancestor: String, mine: String, theirs: String) {
        guard let merged = Self.diff3Merge(mine: mine, ancestor: ancestor, theirs: theirs) else {
            presentError("Couldn’t merge", "The merge tool failed, so nothing was changed. Use Keep My Version or Reload from Disk instead.")
            return
        }

        do {
            try merged.text.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            presentError("Couldn’t save the merged file", error.localizedDescription)
            return
        }
        openFile(url)

        if merged.hadConflicts {
            let alert = NSAlert()
            alert.messageText = "Merged, with conflicts to settle."
            alert.informativeText = "Both versions were kept. Where the two edited the same lines, you'll find them marked with “\(Self.conflictMine)” - delete the version you don't want, and the marker lines with it."
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    /// Run the system's `diff3` and translate its markers into markdown-safe
    /// ones. Returns nil if the merge tool itself failed.
    static func diff3Merge(mine: String, ancestor: String, theirs: String) -> (text: String, hadConflicts: Bool)? {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("markwise-merge-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        guard (try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)) != nil
        else { return nil }

        // diff3 is line-based, so every side needs a trailing newline or the
        // last line of each gets treated as different from the others.
        func write(_ text: String, _ name: String) -> URL? {
            let url = dir.appendingPathComponent(name)
            let padded = text.hasSuffix("\n") ? text : text + "\n"
            return (try? padded.write(to: url, atomically: true, encoding: .utf8)) == nil ? nil : url
        }
        guard let mineURL = write(mine, "mine"),
              let baseURL = write(ancestor, "base"),
              let theirsURL = write(theirs, "theirs")
        else { return nil }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/diff3")
        process.arguments = ["-m", mineURL.path, baseURL.path, theirsURL.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        // 0 = merged cleanly, 1 = merged with conflicts, anything else = failure.
        guard process.terminationStatus <= 1, let output = String(data: data, encoding: .utf8) else { return nil }

        return (rewriteConflictMarkers(output), process.terminationStatus == 1)
    }

    /// Swap diff3's markers for markdown-safe ones, drop the common-ancestor
    /// section (a third copy of the text is noise when settling prose), and
    /// leave blank lines around each marker so it stays its own paragraph
    /// instead of being absorbed into the text above it.
    static func rewriteConflictMarkers(_ merged: String) -> String {
        var out: [String] = []
        var inAncestorSection = false

        for line in merged.components(separatedBy: "\n") {
            if line.hasPrefix("<<<<<<<") {
                out.append(contentsOf: ["", conflictMine, ""])
                inAncestorSection = false
            } else if line.hasPrefix("|||||||") {
                inAncestorSection = true // skip diff3's copy of the original
            } else if line == "=======" {
                out.append(contentsOf: ["", conflictTheirs, ""])
                inAncestorSection = false
            } else if line.hasPrefix(">>>>>>>") {
                out.append(contentsOf: ["", conflictEnd, ""])
                inAncestorSection = false
            } else if !inAncestorSection {
                out.append(line)
            }
        }

        // Collapse the runs of blank lines the markers introduce.
        var tidied: [String] = []
        for line in out {
            if line.isEmpty, tidied.last?.isEmpty == true { continue }
            tidied.append(line)
        }
        return tidied.joined(separator: "\n")
    }

    func save() {
        if let url = currentURL { writeMarkdown(to: url) } else { saveAs() }
    }

    func exportPDF() {
        guard webReady, !isExportingPDF else { return }
        isExportingPDF = true

        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        let basename = currentURL?.deletingPathExtension().lastPathComponent ?? "Untitled"
        panel.nameFieldStringValue = "\(basename).pdf"
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            guard response == .OK, let destination = panel.url else {
                self.isExportingPDF = false
                return
            }
            self.preparePDFExport(to: destination)
        }
    }

    private func preparePDFExport(to destination: URL) {
        webView.evaluateJavaScript("window.MW.preparePdfExport()") { [weak self] result, error in
            guard let self else { return }
            guard error == nil,
                  let readiness = result as? [String: Any],
                  readiness["ok"] as? Bool == true else {
                let readiness = result as? [String: Any]
                let missing = readiness?["missingImages"] as? [String] ?? []
                let detail = missing.isEmpty
                    ? (error?.localizedDescription ?? "The document could not be prepared for export.")
                    : "The following images could not be loaded:\n\n\(missing.prefix(20).joined(separator: "\n"))"
                self.finishPDFExport(error: detail)
                return
            }
            self.writePDF(to: destination)
        }
    }

    private func writePDF(to destination: URL) {
        let printInfo = NSPrintInfo.shared.copy() as! NSPrintInfo
        printInfo.topMargin = 36
        printInfo.bottomMargin = 36
        printInfo.leftMargin = 36
        printInfo.rightMargin = 36
        printInfo.horizontalPagination = .fit
        printInfo.verticalPagination = .automatic
        printInfo.jobDisposition = .save
        printInfo.dictionary()[.jobSavingURL] = destination as NSURL

        let operation = webView.printOperation(with: printInfo)
        operation.jobTitle = currentURL?.lastPathComponent ?? "Untitled"
        operation.showsPrintPanel = false
        operation.showsProgressPanel = true
        let succeeded = operation.run()
        finishPDFExport(error: succeeded ? nil : "The print engine could not create the PDF document.")
    }

    private func finishPDFExport(error: String?) {
        webView.evaluateJavaScript("window.MW.finishPdfExport()") { [weak self] _, _ in
            guard let self else { return }
            self.isExportingPDF = false
            if let error { self.presentError("Couldn’t export PDF", error) }
        }
    }

    /// `completion` reports whether the document ended up on disk - the caller
    /// needs that when a save stands between the user and closing or quitting.
    func saveAs(_ completion: ((Bool) -> Void)? = nil) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = ["md", "markdown"]
            .compactMap { UTType(filenameExtension: $0) }
        panel.nameFieldStringValue = currentURL?.lastPathComponent ?? "Untitled.md"
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = panel.url else {
                completion?(false) // backed out of the panel
                return
            }
            self.currentURL = url
            // The document may have moved directories, so relative image paths
            // now resolve somewhere else.
            let base = self.jsString(url.deletingLastPathComponent().absoluteString)
            self.webView.evaluateJavaScript("window.MW.setBaseURL(\(base))", completionHandler: nil)
            self.writeMarkdown(to: url, completion: completion)
        }
    }

    func writeMarkdown(to url: URL, completion: ((Bool) -> Void)? = nil) {
        fetchMarkdown { [weak self] md in
            guard let self else { completion?(false); return }
            do {
                try md.write(to: url, atomically: true, encoding: .utf8)
                self.lastKnownModification = self.modificationDate(of: url)
                self.lastSyncedText = md
                self.setDirty(false)
                self.webView.evaluateJavaScript("window.MW.markSaved()", completionHandler: nil)
                self.updateDocumentBase(for: url)
                self.updateTitle()
                NSDocumentController.shared.noteNewRecentDocumentURL(url)
                completion?(true)
            } catch {
                self.presentError("Couldn’t save file", error.localizedDescription)
                completion?(false)
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

    /// Ask about unsaved changes before closing or quitting. `completion` is
    /// true when it's safe to proceed - the document was saved, or the user
    /// chose to throw the changes away.
    func confirmDiscardIfNeeded(_ completion: @escaping (Bool) -> Void) {
        guard isDirty else { completion(true); return }
        window.makeKeyAndOrderFront(nil) // make it obvious which document this is

        let alert = NSAlert()
        alert.messageText = "Do you want to save the changes you made to “\(currentURL?.lastPathComponent ?? "Untitled")”?"
        alert.informativeText = "Your changes will be lost if you don’t save them."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Don’t Save")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            // An untitled document has nowhere to go yet, so ask where. If the
            // save doesn't happen - no destination chosen, or the write failed -
            // don't proceed, or "Save" would quietly discard the work instead.
            if let url = currentURL {
                writeMarkdown(to: url) { completion($0) }
            } else {
                saveAs { completion($0) }
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
