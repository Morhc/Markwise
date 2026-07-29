// Markwise — Windows host (Tauri 2 + WebView2).
//
// This is the Windows counterpart of the macOS `swift/main.swift` AppDelegate.
// It loads the SAME bundled Milkdown editor (app/web/) and replicates the
// JS<->native bridge contract:
//   native -> JS : window.MW.open(<json>) / getMarkdown() / markSaved()  (via eval)
//   JS -> native : {type: ready|opened|dirty|clean|openLink|editImage}   (via the
//                  webkit shim in init.js, which forwards to `bridge_message`)
//
// editor.js is reused byte-for-byte; the WKWebView-specific
// window.webkit.messageHandlers.bridge it posts to is shimmed in init.js.
//
// Document model: one window == one document, mirroring the macOS
// AppDelegate/DocumentWindow split. Per-window state lives in
// `AppState.docs`, keyed by window label; `recent` is app-wide. Unlike macOS
// (one global menu bar), each window owns its own menu — so menu events arrive
// already tagged with the window they came from and there is no "which document
// is active?" guessing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{
    CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_dialog::DialogExt;

/// The init script: bridge shim + find-in-page overlay. Runs before bundle.js.
const INIT_SCRIPT: &str = include_str!("init.js");

const MARKDOWN_EXTS: &[&str] = &[
    "md", "markdown", "mdown", "mkd", "mdwn", "mkdn", "text", "txt",
];
const RECENT_LIMIT: usize = 10;

const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "heic", "avif",
];
/// Images are embedded as base64 data URIs, so they land in the .md verbatim and
/// grow it by ~4/3. macOS has no such guard; a 12 MB PNG there becomes a ~16 MB
/// string inside an eval and then inside the saved file.
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Per-window document state (the macOS `DocumentWindow` fields).
#[derive(Default)]
struct Doc {
    current_path: Option<PathBuf>,
    dirty: bool,
    web_ready: bool,
    /// A file requested before this window's editor signalled `ready`.
    pending_path: Option<PathBuf>,
    /// Outline sidebar visibility. The host is the source of truth (the menu
    /// checkmark has to agree with it), so this drives window.MW.setOutline.
    outline: bool,
}

#[derive(Default)]
struct AppState {
    /// Keyed by window label. One entry per open document window.
    docs: Mutex<HashMap<String, Doc>>,
    /// App-wide, not per-document.
    recent: Mutex<Vec<PathBuf>>,
    /// Monotonic counter behind the `doc-N` window labels.
    next_id: AtomicU64,
}

/// What to do after a (possibly dirty-guarded) save completes. "New" and "Open"
/// no longer need a guard: they create their own window and leave the current
/// document alone, exactly as the macOS host does.
enum AfterSave {
    None,
    Close,
}

#[derive(PartialEq)]
enum DiscardChoice {
    Save,
    DontSave,
    Cancel,
}

// ---------------------------------------------------------------------------
// State accessors
// ---------------------------------------------------------------------------

/// Run `f` against the `Doc` for `label`, creating a default entry if needed.
/// Every read/write of per-window state goes through here so the lock scope is
/// always a single expression and can never be held across an `eval`.
fn with_doc<T>(app: &AppHandle, label: &str, f: impl FnOnce(&mut Doc) -> T) -> T {
    let st = app.state::<AppState>();
    let mut docs = st.docs.lock().unwrap();
    f(docs.entry(label.to_string()).or_default())
}

fn recent_snapshot(app: &AppHandle) -> Vec<PathBuf> {
    app.state::<AppState>().recent.lock().unwrap().clone()
}

/// The window a document action applies to when only an `AppHandle` is in hand.
/// (`Manager::get_focused_window` is behind tauri's `unstable` feature, so this
/// scans the window map instead.)
fn active_window(app: &AppHandle) -> Option<WebviewWindow> {
    let wins = app.webview_windows();
    wins.values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| wins.values().next())
        .cloned()
}

// ---------------------------------------------------------------------------
// Commands (called from JS via init.js / the invoke shim)
// ---------------------------------------------------------------------------

#[tauri::command]
fn bridge_message(app: AppHandle, win: WebviewWindow, msg: serde_json::Value) {
    let kind = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "ready" => {
            let pending = with_doc(&app, win.label(), |d| {
                d.web_ready = true;
                d.pending_path.take()
            });
            if let Some(p) = pending {
                open_file(&win, p);
            }
        }
        "dirty" => set_dirty(&win, true),
        "clean" => set_dirty(&win, false),
        // Ctrl/Cmd-click on a link in the editor.
        "openLink" => {
            if let Some(href) = msg.get("href").and_then(|v| v.as_str()) {
                open_external(href);
            }
        }
        // Windows-only, emitted by the image prompt in init.js (macOS does both
        // of these inside its NSAlert). "editImage" itself never reaches here —
        // init.js intercepts it to show the prompt.
        "chooseImage" => {
            let w = win.clone();
            app.dialog()
                .file()
                .add_filter("Images", IMAGE_EXTS)
                .pick_file(move |fp| {
                    if let Some(p) = fp.and_then(|f| f.into_path().ok()) {
                        apply_image_source(&w, &p);
                    }
                });
        }
        "imageFromPath" => {
            if let Some(p) = msg.get("path").and_then(|v| v.as_str()) {
                apply_image_source(&win, &normalize_local_path(p));
            }
        }
        _ => {} // "opened" and anything else: no-op
    }
}

// ---------------------------------------------------------------------------
// External links
// ---------------------------------------------------------------------------

/// True for URLs the app should hand to the OS rather than navigate to.
///
/// This allowlist is security-relevant, not cosmetic: it gates `ShellExecuteW`,
/// and it is reached from `on_new_window`, which fires on URLs that came out of
/// whatever markdown the user pasted. `ShellExecuteW` on a `file:` URL or a bare
/// path would happily launch the program it points at.
fn is_external_scheme(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "mailto")
}

#[cfg(windows)]
fn open_external(href: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let scheme = href.split(':').next().unwrap_or("").to_ascii_lowercase();
    if !is_external_scheme(&scheme) {
        return;
    }
    let op: Vec<u16> = "open\0".encode_utf16().collect();
    let url: Vec<u16> = format!("{}\0", href).encode_utf16().collect();
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL as _,
        );
    }
}

#[cfg(not(windows))]
fn open_external(_href: &str) {}

/// Does this URL belong to the app itself? On Windows the frontend is served
/// from `http://tauri.localhost`, which IS scheme `http` — so the navigation
/// filter has to check the host first or it cancels the app's own page load.
fn is_app_url(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    host.is_empty()
        || host == "localhost"
        || host.ends_with("tauri.localhost")
        || host.ends_with("asset.localhost")
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

fn has_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| exts.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        "heic" => "image/heic",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// Read an image file into a `data:` URI (the macOS `fileToDataURI`).
fn file_to_data_uri(path: &Path) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "This image is {:.1} MB. Markwise embeds images in the document, so they are limited to {} MB.",
            meta.len() as f64 / (1024.0 * 1024.0),
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    Ok(format!("data:{};base64,{}", mime_for(&ext), STANDARD.encode(bytes)))
}

/// Turn what the user typed into the image prompt into a path (the Windows
/// counterpart of the macOS `normalizedImageSrc`): strip a `file://` prefix,
/// percent-decode it, and expand `%VAR%` environment references.
fn normalize_local_path(raw: &str) -> PathBuf {
    let mut s = raw.trim().to_string();

    if let Some(rest) = s
        .strip_prefix("file:///")
        .or_else(|| s.strip_prefix("file://"))
    {
        // Percent-decoding, only over the bytes a file URL actually escapes.
        let bytes = rest.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        }
        s = String::from_utf8_lossy(&out).replace('/', "\\");
    }

    PathBuf::from(expand_env_vars(&s))
}

/// Expand `%VAR%` references (`%USERPROFILE%\Pictures\x.png`). Unknown names are
/// left as-is, one pass, so nothing can loop on a value that itself contains `%`.
fn expand_env_vars(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find('%') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('%') {
            Some(close) => {
                let name = &after[..close];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[close + 1..];
            }
            // Unpaired '%': keep it and stop looking.
            None => {
                out.push('%');
                rest = after;
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Read `path` and hand it to the editor as a data: URI (macOS `applyImageSource`).
fn apply_image_source(win: &WebviewWindow, path: &Path) {
    match file_to_data_uri(path) {
        Ok(uri) => {
            let json = serde_json::to_string(&uri).unwrap_or_else(|_| "\"\"".to_string());
            eval_in(win, &format!("window.MW && window.MW.setImageSrc({});", json));
        }
        Err(e) => {
            // Leave the image as it was, and clear editor.js's pending position.
            eval_in(win, "window.MW && window.MW.setImageSrc('');");
            show_error(
                win.app_handle(),
                "Couldn't use that image",
                &format!("{}\n\n{}", path.display(), e),
            );
        }
    }
}

/// Files dropped onto a document window.
///
/// Rust owns drops here, not the webview: `drag_drop_handler_enabled` defaults
/// to true, so wry intercepts WebView2's drop and the page never sees an HTML5
/// `drop` event. (Crepe's own uploader therefore only ever fires on paste.)
fn handle_drop(win: &WebviewWindow, paths: Vec<PathBuf>, position: tauri::PhysicalPosition<f64>) {
    let images: Vec<PathBuf> = paths
        .iter()
        .filter(|p| has_ext(p, IMAGE_EXTS))
        .cloned()
        .collect();

    if images.is_empty() {
        // Not images — but a dropped .md is a reasonable "open this".
        if let Some(md) = paths.into_iter().find(|p| has_ext(p, MARKDOWN_EXTS)) {
            open_in_window(win.app_handle(), md);
        }
        return;
    }

    // Windows and CSS share a top-left origin, so there is no Y flip to do
    // (unlike AppKit). But `position` is in PHYSICAL pixels and posAtCoords()
    // wants CSS pixels — without this division drops land in the wrong place on
    // any display that isn't at 100% scaling.
    let scale = win.scale_factor().unwrap_or(1.0);
    let (x, y) = (position.x / scale, position.y / scale);
    let coords = if x.is_finite() && y.is_finite() {
        format!("{}, {}", x, y)
    } else {
        // insertImages() falls back to the cursor for non-numeric coordinates.
        "null, null".to_string()
    };

    let win = win.clone();
    // Off the main thread: reading a dehydrated OneDrive placeholder can block
    // for seconds while the file is hydrated.
    std::thread::spawn(move || {
        let mut srcs = Vec::new();
        for p in images {
            match file_to_data_uri(&p) {
                Ok(uri) => srcs.push(uri),
                Err(e) => show_error(
                    win.app_handle(),
                    "Couldn't insert image",
                    &format!("{}\n\n{}", p.display(), e),
                ),
            }
        }
        if srcs.is_empty() {
            return;
        }
        let json = serde_json::to_string(&srcs).unwrap_or_else(|_| "[]".to_string());
        eval_in(
            &win,
            &format!("window.MW && window.MW.insertImages({}, {});", json, coords),
        );
    });
}

// ---------------------------------------------------------------------------
// native -> JS helpers
// ---------------------------------------------------------------------------

fn eval_in(win: &WebviewWindow, js: &str) {
    let _ = win.eval(js);
}

/// Tell the window's init.js which directory to resolve relative image paths
/// against (`![](./img/a.png)`). Windows-only; macOS has no equivalent because
/// relative paths don't render there either.
fn set_doc_dir(win: &WebviewWindow, path: &Path) {
    let dir = path.parent().map(|d| d.display().to_string()).unwrap_or_default();
    let json = serde_json::to_string(&dir).unwrap_or_else(|_| "\"\"".to_string());
    eval_in(win, &format!("window.__mwSetDocDir && window.__mwSetDocDir({});", json));
}

fn send_to_editor(win: &WebviewWindow, text: &str) {
    // serde_json gives a correctly-escaped JS string literal (matches the Swift
    // JSONEncoder approach).
    let json = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
    eval_in(win, &format!("window.MW && window.MW.open({});", json));
}

/// Pull the current markdown out of a window's editor. MUST be called off the
/// main thread: the WebView2 script-completion callback is delivered on the UI
/// thread, so blocking the main thread here would deadlock.
fn fetch_markdown(win: &WebviewWindow) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    win.eval_with_callback(
        "(window.MW && window.MW.getMarkdown) ? window.MW.getMarkdown() : ''",
        move |json| {
            let _ = tx.send(json);
        },
    )
    .ok()?;
    let json = rx.recv_timeout(Duration::from_secs(5)).ok()?;
    serde_json::from_str::<String>(&json).ok()
}

// ---------------------------------------------------------------------------
// Title / dirty
// ---------------------------------------------------------------------------

fn set_dirty(win: &WebviewWindow, dirty: bool) {
    with_doc(win.app_handle(), win.label(), |d| d.dirty = dirty);
    update_title(win);
}

fn update_title(win: &WebviewWindow) {
    let (name, dirty) = with_doc(win.app_handle(), win.label(), |d| {
        let name = d
            .current_path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".to_string());
        (name, d.dirty)
    });
    let title = if dirty { format!("\u{2022} {}", name) } else { name };
    let _ = win.set_title(&title);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/// Logical top-left for a cascaded new window, offset from the active one.
fn cascade_from(app: &AppHandle) -> Option<(f64, f64)> {
    let w = active_window(app)?;
    let scale = w.scale_factor().unwrap_or(1.0);
    let p = w.outer_position().ok()?;
    Some((p.x as f64 / scale + 28.0, p.y as f64 / scale + 28.0))
}

/// Create an empty document window (the macOS `makeDocumentWindow`).
fn make_document_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let n = app.state::<AppState>().next_id.fetch_add(1, Ordering::Relaxed);
    let label = format!("doc-{}", n);
    let menu = build_menu(app, &recent_snapshot(app), false)?;

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Untitled")
        .inner_size(900.0, 720.0)
        // 600x420 (up from 480x360): the floating block handle is 66px wide and
        // needs the editor's 88px gutter to stay on-screen.
        .min_inner_size(600.0, 420.0)
        .initialization_script(INIT_SCRIPT)
        .menu(menu)
        .on_menu_event(|w, ev| handle_menu(w.app_handle(), w.label(), ev.id().as_ref()))
        // A real <a> navigation to the web: cancel it and hand it to the browser.
        .on_navigation(|url| {
            if is_app_url(url) {
                return true;
            }
            if is_external_scheme(url.scheme()) {
                open_external(url.as_str());
                return false;
            }
            true
        })
        // target="_blank" (Milkdown's link tooltip) goes through WebView2's
        // new-window request instead, which never reaches on_navigation.
        .on_new_window(|url, _features| {
            open_external(url.as_str());
            tauri::webview::NewWindowResponse::Deny
        });

    builder = match cascade_from(app) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };

    let win = builder.build()?;
    with_doc(app, &label, |_| {}); // register the (empty) document

    let h = app.clone();
    let label_for_event = label.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(w) = h.get_webview_window(&label_for_event) {
                guard_then(&w, AfterSave::Close);
            }
        }
        WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) => {
            if let Some(w) = h.get_webview_window(&label_for_event) {
                handle_drop(&w, paths.clone(), *position);
            }
        }
        WindowEvent::Destroyed => {
            h.state::<AppState>()
                .docs
                .lock()
                .unwrap()
                .remove(&label_for_event);
        }
        _ => {}
    });

    Ok(win)
}

/// Open `path`, reusing the window that already shows it (macOS `openInWindow`).
fn open_in_window(app: &AppHandle, path: PathBuf) {
    let existing = {
        let st = app.state::<AppState>();
        let docs = st.docs.lock().unwrap();
        docs.iter()
            .find(|(_, d)| d.current_path.as_deref() == Some(path.as_path()))
            .map(|(l, _)| l.clone())
    };
    if let Some(label) = existing {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.set_focus();
            return;
        }
    }
    match make_document_window(app) {
        // The editor isn't ready yet, so this parks the path in `pending_path`
        // and the `ready` bridge message flushes it.
        Ok(w) => open_file(&w, path),
        Err(e) => show_error(app, "Couldn't open a window", &e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Document operations
// ---------------------------------------------------------------------------

fn open_file(win: &WebviewWindow, path: PathBuf) {
    let app = win.app_handle().clone();
    // Gate on editor readiness (subtlety #1 from the macOS host).
    let ready = with_doc(&app, win.label(), |d| d.web_ready);
    if !ready {
        with_doc(&app, win.label(), |d| d.pending_path = Some(path));
        return;
    }
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            show_error(&app, "Couldn't open file", &e.to_string());
            return;
        }
    };
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => {
            show_error(&app, "Couldn't open file", "The file is not valid UTF-8 text.");
            return;
        }
    };
    with_doc(&app, win.label(), |d| {
        d.current_path = Some(path.clone());
        d.dirty = false;
    });
    set_doc_dir(win, &path);
    send_to_editor(win, &text);
    push_recent(&app, &path);
    update_title(win);
    refresh_menus(&app);
}

fn open_dialog(app: &AppHandle) {
    let app = app.clone();
    app.clone()
        .dialog()
        .file()
        .add_filter("Markdown", MARKDOWN_EXTS)
        .pick_files(move |fps| {
            for p in fps
                .unwrap_or_default()
                .into_iter()
                .filter_map(|f| f.into_path().ok())
            {
                open_in_window(&app, p);
            }
        });
}

fn save_document(win: &WebviewWindow) {
    let path = with_doc(win.app_handle(), win.label(), |d| d.current_path.clone());
    match path {
        Some(p) => save_to_path(win, p, None),
        None => save_document_as(win, AfterSave::None),
    }
}

fn save_document_as(win: &WebviewWindow, after: AfterSave) {
    let win2 = win.clone();
    let name = with_doc(win.app_handle(), win.label(), |d| {
        d.current_path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled.md".to_string())
    });
    win.app_handle()
        .dialog()
        .file()
        .set_file_name(&name)
        .add_filter("Markdown", &["md", "markdown"])
        .save_file(move |fp| {
            if let Some(fp) = fp {
                if let Ok(p) = fp.into_path() {
                    save_to_path(&win2, p, Some(after));
                }
            }
            // Cancelled: `after` is dropped → the pending action is aborted.
        });
}

/// Write the window's current markdown to `path` on a background thread, then
/// optionally run `after` (back on the main thread).
fn save_to_path(win: &WebviewWindow, path: PathBuf, after: Option<AfterSave>) {
    let win = win.clone();
    std::thread::spawn(move || {
        let app = win.app_handle().clone();
        let md = fetch_markdown(&win).unwrap_or_default();
        match atomic_write(&path, md.as_bytes()) {
            Ok(()) => {
                with_doc(&app, win.label(), |d| {
                    d.current_path = Some(path.clone());
                    d.dirty = false;
                });
                // Save As can move the document, which moves what its relative
                // image paths resolve against.
                set_doc_dir(&win, &path);
                eval_in(&win, "window.MW && window.MW.markSaved && window.MW.markSaved();");
                push_recent(&app, &path);
                update_title(&win);
                refresh_menus(&app);
                if let Some(a) = after {
                    let w2 = win.clone();
                    let _ = app.run_on_main_thread(move || execute_after(&w2, a));
                }
            }
            Err(e) => show_error(&app, "Couldn't save file", &e.to_string()),
        }
    });
}

/// Atomic-ish write: temp file in the same dir + rename, with a direct-write
/// fallback (e.g. when a OneDrive-synced target briefly locks the rename).
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let fname = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "out".to_string());
    let tmp = dir.join(format!(".{}.mwtmp", fname));
    std::fs::write(&tmp, bytes)?;
    let r = match std::fs::rename(&tmp, path) {
        Ok(()) => return Ok(()),
        Err(_) => std::fs::write(path, bytes),
    };
    // The rename failed, so the temp file is still there whether or not the
    // direct write succeeded — always clean it up.
    let _ = std::fs::remove_file(&tmp);
    r
}

// ---------------------------------------------------------------------------
// Dirty guard ("save changes?") and follow-up actions
// ---------------------------------------------------------------------------

fn guard_then(win: &WebviewWindow, after: AfterSave) {
    let dirty = with_doc(win.app_handle(), win.label(), |d| d.dirty);
    if !dirty {
        execute_after(win, after);
        return;
    }
    match confirm_discard(win) {
        DiscardChoice::Cancel => {} // abort
        DiscardChoice::DontSave => {
            set_dirty(win, false);
            execute_after(win, after);
        }
        DiscardChoice::Save => {
            let path = with_doc(win.app_handle(), win.label(), |d| d.current_path.clone());
            match path {
                Some(p) => save_to_path(win, p, Some(after)),
                None => save_document_as(win, after),
            }
        }
    }
}

/// Runs on the main thread.
fn execute_after(win: &WebviewWindow, after: AfterSave) {
    match after {
        AfterSave::None => {}
        // Destroy this window only. Tauri exits once the last one is gone.
        AfterSave::Close => {
            let _ = win.destroy();
        }
    }
}

// ---------------------------------------------------------------------------
// Native dialogs
// ---------------------------------------------------------------------------

fn show_error(app: &AppHandle, title: &str, detail: &str) {
    use tauri_plugin_dialog::MessageDialogKind;
    app.dialog()
        .message(detail)
        .title(title)
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

#[cfg(windows)]
fn confirm_discard(win: &WebviewWindow) -> DiscardChoice {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDNO, IDYES, MB_ICONWARNING, MB_YESNOCANCEL,
    };
    let caption: Vec<u16> = "Do you want to save the changes?\0".encode_utf16().collect();
    let text: Vec<u16> = "Your changes will be lost if you don't save them.\0"
        .encode_utf16()
        .collect();
    // Own the box to its document window so it's modal to the right one.
    // tauri's HWND is the `windows` crate newtype; windows-sys wants the raw ptr.
    let owner = win.hwnd().map(|h| h.0).unwrap_or(std::ptr::null_mut());
    let ret = unsafe {
        MessageBoxW(
            owner,
            text.as_ptr(),
            caption.as_ptr(),
            MB_YESNOCANCEL | MB_ICONWARNING,
        )
    };
    match ret {
        IDYES => DiscardChoice::Save,
        IDNO => DiscardChoice::DontSave,
        _ => DiscardChoice::Cancel,
    }
}

#[cfg(not(windows))]
fn confirm_discard(_win: &WebviewWindow) -> DiscardChoice {
    // The Windows branch targets Windows; this keeps `cargo check` green elsewhere.
    DiscardChoice::DontSave
}

// ---------------------------------------------------------------------------
// Recent files
// ---------------------------------------------------------------------------

fn recent_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("recent.json"))
}

fn load_recent(app: &AppHandle) -> Vec<PathBuf> {
    if let Some(p) = recent_path(app) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Vec<String>>(&s) {
                return v.into_iter().map(PathBuf::from).collect();
            }
        }
    }
    Vec::new()
}

fn push_recent(app: &AppHandle, path: &Path) {
    let list: Vec<String> = {
        let st = app.state::<AppState>();
        let mut r = st.recent.lock().unwrap();
        r.retain(|p| p != path);
        r.insert(0, path.to_path_buf());
        r.truncate(RECENT_LIMIT);
        r.iter().map(|p| p.display().to_string()).collect()
    };
    if let Some(p) = recent_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&p, serde_json::to_string_pretty(&list).unwrap_or_default());
    }
}

// ---------------------------------------------------------------------------
// Menu
//
// One menu per window (the Windows convention). Menu events therefore arrive
// tagged with their originating window, so nothing has to guess which document
// is active — this is why `App::set_menu` is never used: on non-macOS it pushes
// the same menu into every window.
// ---------------------------------------------------------------------------

fn build_menu(
    app: &AppHandle,
    recent: &[PathBuf],
    outline: bool,
) -> tauri::Result<tauri::menu::Menu<Wry>> {
    let new = MenuItemBuilder::with_id("new", "New").accelerator("CmdOrCtrl+N").build(app)?;
    let open = MenuItemBuilder::with_id("open", "Open\u{2026}").accelerator("CmdOrCtrl+O").build(app)?;

    let mut recent_sub = SubmenuBuilder::with_id(app, "open_recent", "Open Recent");
    if recent.is_empty() {
        let empty = MenuItemBuilder::with_id("recent_empty", "(No Recent Files)")
            .enabled(false)
            .build(app)?;
        recent_sub = recent_sub.item(&empty);
    } else {
        for (i, p) in recent.iter().enumerate() {
            let label = p
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.display().to_string());
            let it = MenuItemBuilder::with_id(format!("recent::{}", i), label).build(app)?;
            recent_sub = recent_sub.item(&it);
        }
    }
    let open_recent = recent_sub.build()?;

    let save = MenuItemBuilder::with_id("save", "Save").accelerator("CmdOrCtrl+S").build(app)?;
    let saveas = MenuItemBuilder::with_id("saveas", "Save As\u{2026}")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let close = MenuItemBuilder::with_id("close", "Close").accelerator("CmdOrCtrl+W").build(app)?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&new)
        .item(&open)
        .item(&open_recent)
        .separator()
        .item(&save)
        .item(&saveas)
        .separator()
        .item(&close)
        .build()?;

    let find = MenuItemBuilder::with_id("find", "Find\u{2026}").accelerator("CmdOrCtrl+F").build(app)?;
    let find_next = MenuItemBuilder::with_id("find_next", "Find Next").accelerator("CmdOrCtrl+G").build(app)?;
    let find_prev = MenuItemBuilder::with_id("find_prev", "Find Previous")
        .accelerator("CmdOrCtrl+Shift+G")
        .build(app)?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&find)
        .item(&find_next)
        .item(&find_prev)
        .build()?;

    // macOS uses Alt+Cmd+O; on Windows Alt opens the menu bar and Ctrl+O is
    // Open, so this follows the Ctrl+Shift+_ convention for panel toggles.
    let outline_item = CheckMenuItemBuilder::with_id("outline", "Show Document Outline")
        .checked(outline)
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let fullscreen = MenuItemBuilder::with_id("fullscreen", "Toggle Full Screen")
        .accelerator("F11")
        .build(app)?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&outline_item)
        .separator()
        .item(&fullscreen)
        .build()?;

    MenuBuilder::new(app).item(&file).item(&edit).item(&view).build()
}

/// Rebuild every window's menu (the Open Recent list is app-wide, so a save in
/// one window has to refresh the others too).
fn refresh_menus(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let recent = recent_snapshot(&app);
        for (label, w) in app.webview_windows() {
            // Seed each rebuild with that window's own outline state, or the
            // rebuild would silently uncheck the item.
            let outline = with_doc(&app, &label, |d| d.outline);
            if let Ok(menu) = build_menu(&app, &recent, outline) {
                let _ = w.set_menu(menu);
            }
        }
    });
}

fn handle_menu(app: &AppHandle, label: &str, id: &str) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    match id {
        // New/Open get their own window, so the current document is untouched
        // and needs no dirty guard.
        "new" => {
            if let Err(e) = make_document_window(app) {
                show_error(app, "Couldn't open a window", &e.to_string());
            }
        }
        "open" => open_dialog(app),
        "save" => save_document(&win),
        "saveas" => save_document_as(&win, AfterSave::None),
        "close" => guard_then(&win, AfterSave::Close),
        "find" => eval_in(&win, "window.__mwFind && window.__mwFind.show();"),
        "find_next" => eval_in(&win, "window.__mwFind && window.__mwFind.next();"),
        "find_prev" => eval_in(&win, "window.__mwFind && window.__mwFind.prev();"),
        "outline" => {
            let visible = with_doc(app, label, |d| {
                d.outline = !d.outline;
                d.outline
            });
            eval_in(&win, &format!("window.MW && window.MW.setOutline({});", visible));
            // Flip just this item rather than rebuilding the whole menu.
            if let Some(menu) = win.menu() {
                if let Some(item) = menu.get("outline").and_then(|k| k.as_check_menuitem().cloned())
                {
                    let _ = item.set_checked(visible);
                }
            }
        }
        "fullscreen" => {
            let f = win.is_fullscreen().unwrap_or(false);
            let _ = win.set_fullscreen(!f);
        }
        other => {
            if let Some(idx) = other.strip_prefix("recent::").and_then(|s| s.parse::<usize>().ok()) {
                let p = app.state::<AppState>().recent.lock().unwrap().get(idx).cloned();
                if let Some(p) = p {
                    open_in_window(app, p);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// argv / file association
// ---------------------------------------------------------------------------

/// Every existing file in argv (macOS `application(_:open:)` loops all URLs).
fn file_args(args: &[String]) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .collect()
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch (e.g. double-clicking another .md): open each file
            // in its own window, matching the macOS host.
            let files = file_args(&argv);
            if files.is_empty() {
                if let Some(w) = active_window(app) {
                    let _ = w.set_focus();
                }
            } else {
                for f in files {
                    open_in_window(app, f);
                }
            }
        }))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![bridge_message])
        .setup(|app| {
            let handle = app.handle().clone();

            let recent = load_recent(&handle);
            *handle.state::<AppState>().recent.lock().unwrap() = recent;

            // One window per file on the command line (file association / CLI),
            // or a single empty one.
            let files = file_args(&std::env::args().collect::<Vec<_>>());
            if files.is_empty() {
                make_document_window(&handle)?;
            } else {
                for f in files {
                    open_in_window(&handle, f);
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Markwise");
}
