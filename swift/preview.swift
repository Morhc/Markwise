// Markwise's Quick Look preview extension (press space on a .md in Finder).
//
// Quick Look never asks the default app for a preview — it asks a Quick Look
// *extension*, so this .appex ships inside Markwise.app and renders the file
// the way Markwise would show it. The pipeline is deliberately static:
//
//   1. src/qlpreview.js (the editor's remark parser family + KaTeX, bundled
//      for JavaScriptCore) converts the markdown to an HTML string — no DOM,
//      no network, inside this sandboxed process.
//   2. Images the document references are inlined as data: URIs, since the
//      preview page gets no filesystem access of its own.
//   3. The finished page goes back as a *data-based* preview
//      (QLPreviewReply, content type HTML): Quick Look's own viewer renders
//      it, with JavaScript off — so scripts hidden in a downloaded markdown
//      file are inert, and this process never has to host a web view. (An
//      earlier version embedded a WKWebView here; WebKit's separate content
//      process refused to launch inside the ad-hoc-signed sandboxed
//      extension, and the preview hung on a spinner. Handing Quick Look the
//      bytes sidesteps the whole problem.)
import Foundation
import QuickLookUI
import JavaScriptCore
import UniformTypeIdentifiers

@objc(PreviewProvider)
final class PreviewProvider: QLPreviewProvider, QLPreviewingController {

    func providePreview(for request: QLFilePreviewRequest,
                        completionHandler handler: @escaping (QLPreviewReply?, Error?) -> Void) {
        do {
            let markdown = try String(contentsOf: request.fileURL, encoding: .utf8)
            let (page, attachments) = try PreviewRenderer.page(
                markdown: markdown,
                baseDir: request.fileURL.deletingLastPathComponent())
            let reply = QLPreviewReply(dataOfContentType: .html,
                                       contentSize: CGSize(width: 700, height: 800)) { _ in
                Data(page.utf8)
            }
            reply.title = request.fileURL.lastPathComponent
            reply.stringEncoding = .utf8
            reply.attachments = attachments
            handler(reply, nil)
        } catch {
            handler(nil, error)
        }
    }
}

enum PreviewError: Error { case bundleBroken, renderFailed(String) }

enum PreviewRenderer {

    /// Markdown -> a complete HTML page plus the attachments it references.
    static func page(markdown: String, baseDir: URL) throws
        -> (html: String, attachments: [String: QLPreviewReplyAttachment]) {
        let bundle = Bundle(for: PreviewProvider.self)
        guard let jsURL = bundle.url(forResource: "qlpreview", withExtension: "js"),
              let cssURL = bundle.url(forResource: "qlpreview", withExtension: "css"),
              let context = JSContext() else { throw PreviewError.bundleBroken }

        var jsProblem: String?
        context.exceptionHandler = { _, exception in
            jsProblem = exception?.toString()
        }
        context.evaluateScript(try String(contentsOf: jsURL, encoding: .utf8))
        let body = context.objectForKeyedSubscript("MWQL")?
            .invokeMethod("render", withArguments: [markdown])?
            .toString()
        if let jsProblem { throw PreviewError.renderFailed(jsProblem) }
        guard var html = body else { throw PreviewError.renderFailed("no output") }

        let attachments = attachLocalImages(in: &html, baseDir: baseDir)
        let css = try String(contentsOf: cssURL, encoding: .utf8)
        let page = """
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><style>\(css)</style>\(fontOverride())</head>\
        <body>\(html)</body></html>
        """
        return (page, attachments)
    }

    /// The View ▸ Font choice, so the preview matches the app. A sandboxed
    /// extension gets its own preferences container, not the app's — but the
    /// read-only exception that loads images also reads the app's plist
    /// directly. NSHomeDirectory() here is the container, so the real home
    /// comes from the passwd entry. An unset or default font adds nothing.
    static func fontOverride() -> String {
        guard let pw = getpwuid(getuid()), let homeC = pw.pointee.pw_dir else { return "" }
        let plist = String(cString: homeC) + "/Library/Preferences/com.josh.markwise.plist"
        guard let data = FileManager.default.contents(atPath: plist),
              let prefs = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let family = (prefs as? [String: Any])?["MWFontFamily"] as? String,
              !family.isEmpty else { return "" }
        let css = family == "-apple-system"
            ? "-apple-system, sans-serif"
            : "'\(family.replacingOccurrences(of: "'", with: ""))', sans-serif"
        return """
        <style>body, h1, h2, h3, h4, h5, h6 { font-family: \(css); }</style>
        """
    }

    /// Rewrite relative <img src> paths to cid: references backed by
    /// QLPreviewReply attachments — the one image mechanism Quick Look's HTML
    /// viewer accepts (data: URIs are rejected). Whether the sandbox lets the
    /// extension read a sibling file at all is decided here, per image; one
    /// that can't be read keeps its path, and the viewer shows the alt text.
    static func attachLocalImages(in html: inout String, baseDir: URL)
        -> [String: QLPreviewReplyAttachment] {
        guard let regex = try? NSRegularExpression(pattern: "src=\"([^\"]+)\"") else { return [:] }
        var attachments: [String: QLPreviewReplyAttachment] = [:]
        let full = NSRange(html.startIndex..., in: html)
        var counter = 0
        // Replace back-to-front so earlier ranges stay valid.
        for match in regex.matches(in: html, range: full).reversed() {
            guard let srcRange = Range(match.range(at: 1), in: html) else { continue }
            let src = String(html[srcRange])
            if src.hasPrefix("data:") || src.hasPrefix("cid:") || src.contains("://") { continue }
            guard let decoded = src.removingPercentEncoding else { continue }
            let fileURL = URL(fileURLWithPath: decoded, relativeTo: baseDir)
            guard let data = try? Data(contentsOf: fileURL) else { continue }
            let type = UTType(filenameExtension: fileURL.pathExtension.lowercased()) ?? .data
            let name = "img\(counter)"
            counter += 1
            attachments[name] = QLPreviewReplyAttachment(data: data, contentType: type)
            if let whole = Range(match.range, in: html) {
                html.replaceSubrange(whole, with: "src=\"cid:\(name)\"")
            }
        }
        return attachments
    }
}
