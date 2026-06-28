// Markwise — Windows host (Tauri 2 + WebView2).
//
// This is the Windows counterpart of the macOS `swift/main.swift` AppDelegate.
// It loads the SAME bundled Milkdown editor (app/web/) and replicates the
// JS<->native bridge contract:
//   native -> JS : window.MW.open(<json>) / getMarkdown() / markSaved()  (via eval)
//   JS -> native : {type: ready|opened|dirty|clean}  (via the webkit shim in init.js
//                  which forwards to the `bridge_message` command)
//
// editor.js is reused byte-for-byte; the WKWebView-specific
// window.webkit.messageHandlers.bridge it posts to is shimmed in init.js.

use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{
    AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_dialog::DialogExt;

/// The init script: bridge shim + find-in-page overlay. Runs before bundle.js.
const INIT_SCRIPT: &str = include_str!("init.js");

const MARKDOWN_EXTS: &[&str] = &[
    "md", "markdown", "mdown", "mkd", "mdwn", "mkdn", "text", "txt",
];
const RECENT_LIMIT: usize = 10;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Doc {
    current_path: Option<PathBuf>,
    dirty: bool,
    web_ready: bool,
    /// A file requested before the editor signalled `ready` (CLI / file association).
    pending_path: Option<PathBuf>,
    recent: Vec<PathBuf>,
}

struct AppState(Mutex<Doc>);

/// One-shot slot for the async `getMarkdown` round-trip (see `fetch_markdown`).
struct MdChannel(Mutex<Option<Sender<String>>>);

/// What to do after a (possibly dirty-guarded) save completes.
enum AfterSave {
    None,
    New,
    OpenDialog,
    OpenPath(PathBuf),
    Close,
}

#[derive(PartialEq)]
enum DiscardChoice {
    Save,
    DontSave,
    Cancel,
}

// ---------------------------------------------------------------------------
// Commands (called from JS via init.js / the invoke shim)
// ---------------------------------------------------------------------------

#[tauri::command]
fn bridge_message(app: AppHandle, msg: serde_json::Value, state: State<'_, AppState>) {
    let kind = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "ready" => {
            let pending = {
                let mut d = state.0.lock().unwrap();
                d.web_ready = true;
                d.pending_path.take()
            };
            if let Some(p) = pending {
                open_file(&app, p);
            }
        }
        "dirty" => set_dirty(&app, true),
        "clean" => set_dirty(&app, false),
        _ => {} // "opened" and anything else: no-op
    }
}

#[tauri::command]
fn get_markdown_result(markdown: String, chan: State<'_, MdChannel>) {
    if let Some(tx) = chan.0.lock().unwrap().take() {
        let _ = tx.send(markdown);
    }
}

// ---------------------------------------------------------------------------
// native -> JS helpers
// ---------------------------------------------------------------------------

fn eval_js(app: &AppHandle, js: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(js);
    }
}

fn send_to_editor(app: &AppHandle, text: &str) {
    // serde_json gives a correctly-escaped JS string literal (matches the Swift
    // JSONEncoder approach).
    let json = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
    eval_js(app, &format!("window.MW && window.MW.open({});", json));
}

/// Pull the current markdown out of the editor. MUST be called off the main
/// thread: it blocks until the webview's `get_markdown_result` invoke returns,
/// which is processed on Tauri's command thread pool while the main event loop
/// keeps pumping the eval'd script.
fn fetch_markdown(app: &AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    {
        *app.state::<MdChannel>().0.lock().unwrap() = Some(tx);
    }
    eval_js(
        app,
        "window.__TAURI_INTERNALS__.invoke('get_markdown_result', { markdown: \
         (window.MW && window.MW.getMarkdown) ? window.MW.getMarkdown() : '' });",
    );
    rx.recv_timeout(Duration::from_secs(5)).ok()
}

// ---------------------------------------------------------------------------
// Title / dirty
// ---------------------------------------------------------------------------

fn set_dirty(app: &AppHandle, dirty: bool) {
    app.state::<AppState>().0.lock().unwrap().dirty = dirty;
    update_title(app);
}

fn update_title(app: &AppHandle) {
    let (name, dirty) = {
        let st = app.state::<AppState>();
        let g = st.0.lock().unwrap();
        let name = g
            .current_path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".to_string());
        (name, g.dirty)
    };
    let title = if dirty { format!("\u{2022} {}", name) } else { name };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(&title);
    }
}

// ---------------------------------------------------------------------------
// Document operations
// ---------------------------------------------------------------------------

fn open_file(app: &AppHandle, path: PathBuf) {
    // Gate on editor readiness (subtlety #1 from the macOS host). Read the flag
    // into a local in its own scope so the guard is dropped before we re-lock.
    let ready = { app.state::<AppState>().0.lock().unwrap().web_ready };
    if !ready {
        app.state::<AppState>().0.lock().unwrap().pending_path = Some(path);
        return;
    }
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            show_error(app, "Couldn't open file", &e.to_string());
            return;
        }
    };
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => {
            show_error(app, "Couldn't open file", "The file is not valid UTF-8 text.");
            return;
        }
    };
    {
        let st = app.state::<AppState>();
        let mut g = st.0.lock().unwrap();
        g.current_path = Some(path.clone());
        g.dirty = false;
    }
    send_to_editor(app, &text);
    push_recent(app, &path);
    update_title(app);
    refresh_menu(app);
}

fn new_document(app: &AppHandle) {
    {
        let st = app.state::<AppState>();
        let mut g = st.0.lock().unwrap();
        g.current_path = None;
        g.dirty = false;
    }
    send_to_editor(app, "");
    update_title(app);
}

fn open_dialog(app: &AppHandle) {
    let app = app.clone();
    app.clone()
        .dialog()
        .file()
        .add_filter("Markdown", MARKDOWN_EXTS)
        .pick_file(move |fp| {
            if let Some(fp) = fp {
                if let Ok(p) = fp.into_path() {
                    open_file(&app, p);
                }
            }
        });
}

fn save_document(app: &AppHandle) {
    let path = app.state::<AppState>().0.lock().unwrap().current_path.clone();
    match path {
        Some(p) => save_to_path(app, p, None),
        None => save_document_as(app, AfterSave::None),
    }
}

fn save_document_as(app: &AppHandle, after: AfterSave) {
    let app2 = app.clone();
    let name = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .current_path
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled.md".to_string());
    app.dialog()
        .file()
        .set_file_name(&name)
        .add_filter("Markdown", &["md", "markdown"])
        .save_file(move |fp| {
            if let Some(fp) = fp {
                if let Ok(p) = fp.into_path() {
                    save_to_path(&app2, p, Some(after));
                }
            }
            // Cancelled: `after` is dropped → the pending action is aborted.
        });
}

/// Write the editor's current markdown to `path` on a background thread, then
/// optionally run `after` (back on the main thread).
fn save_to_path(app: &AppHandle, path: PathBuf, after: Option<AfterSave>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let md = fetch_markdown(&app).unwrap_or_default();
        match atomic_write(&path, md.as_bytes()) {
            Ok(()) => {
                {
                    let st = app.state::<AppState>();
                    let mut g = st.0.lock().unwrap();
                    g.current_path = Some(path.clone());
                    g.dirty = false;
                }
                eval_js(&app, "window.MW && window.MW.markSaved && window.MW.markSaved();");
                push_recent(&app, &path);
                update_title(&app);
                refresh_menu(&app);
                if let Some(a) = after {
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || execute_after(&app2, a));
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
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            let r = std::fs::write(path, bytes);
            let _ = std::fs::remove_file(&tmp);
            r
        }
    }
}

// ---------------------------------------------------------------------------
// Dirty guard ("save changes?") and follow-up actions
// ---------------------------------------------------------------------------

fn guard_then(app: &AppHandle, after: AfterSave) {
    let dirty = app.state::<AppState>().0.lock().unwrap().dirty;
    if !dirty {
        execute_after(app, after);
        return;
    }
    match confirm_discard(app) {
        DiscardChoice::Cancel => {} // abort
        DiscardChoice::DontSave => {
            set_dirty(app, false);
            execute_after(app, after);
        }
        DiscardChoice::Save => {
            let path = app.state::<AppState>().0.lock().unwrap().current_path.clone();
            match path {
                Some(p) => save_to_path(app, p, Some(after)),
                None => save_document_as(app, after),
            }
        }
    }
}

/// Runs on the main thread.
fn execute_after(app: &AppHandle, after: AfterSave) {
    match after {
        AfterSave::None => {}
        AfterSave::New => new_document(app),
        AfterSave::OpenDialog => open_dialog(app),
        AfterSave::OpenPath(p) => open_file(app, p),
        AfterSave::Close => app.exit(0),
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
fn confirm_discard(_app: &AppHandle) -> DiscardChoice {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDNO, IDYES, MB_ICONWARNING, MB_YESNOCANCEL,
    };
    let caption: Vec<u16> = "Do you want to save the changes?\0".encode_utf16().collect();
    let text: Vec<u16> = "Your changes will be lost if you don't save them.\0"
        .encode_utf16()
        .collect();
    let ret = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
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
fn confirm_discard(_app: &AppHandle) -> DiscardChoice {
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
    {
        let st = app.state::<AppState>();
        let mut g = st.0.lock().unwrap();
        g.recent.retain(|p| p != path);
        g.recent.insert(0, path.to_path_buf());
        g.recent.truncate(RECENT_LIMIT);
    }
    let list: Vec<String> = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .recent
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    if let Some(p) = recent_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&p, serde_json::to_string_pretty(&list).unwrap_or_default());
    }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

fn build_menu(app: &AppHandle, recent: &[PathBuf]) -> tauri::Result<tauri::menu::Menu<Wry>> {
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

    let fullscreen = MenuItemBuilder::with_id("fullscreen", "Toggle Full Screen")
        .accelerator("F11")
        .build(app)?;
    let view = SubmenuBuilder::new(app, "View").item(&fullscreen).build()?;

    MenuBuilder::new(app).item(&file).item(&edit).item(&view).build()
}

fn refresh_menu(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let recent = app.state::<AppState>().0.lock().unwrap().recent.clone();
        if let Ok(menu) = build_menu(&app, &recent) {
            let _ = app.set_menu(menu);
        }
    });
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "new" => guard_then(app, AfterSave::New),
        "open" => guard_then(app, AfterSave::OpenDialog),
        "save" => save_document(app),
        "saveas" => save_document_as(app, AfterSave::None),
        "close" => guard_then(app, AfterSave::Close),
        "find" => eval_js(app, "window.__mwFind && window.__mwFind.show();"),
        "find_next" => eval_js(app, "window.__mwFind && window.__mwFind.next();"),
        "find_prev" => eval_js(app, "window.__mwFind && window.__mwFind.prev();"),
        "fullscreen" => {
            if let Some(w) = app.get_webview_window("main") {
                let f = w.is_fullscreen().unwrap_or(false);
                let _ = w.set_fullscreen(!f);
            }
        }
        other => {
            if let Some(idx) = other.strip_prefix("recent::").and_then(|s| s.parse::<usize>().ok()) {
                let p = app.state::<AppState>().0.lock().unwrap().recent.get(idx).cloned();
                if let Some(p) = p {
                    guard_then(app, AfterSave::OpenPath(p));
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// argv / file association
// ---------------------------------------------------------------------------

fn first_file_arg(args: &[String]) -> Option<PathBuf> {
    args.iter().skip(1).map(PathBuf::from).find(|p| p.is_file())
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch (e.g. double-clicking another .md): focus this
            // window and open the file instead of starting a new process.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
            if let Some(p) = first_file_arg(&argv) {
                guard_then(app, AfterSave::OpenPath(p));
            }
        }))
        .manage(AppState(Mutex::new(Doc::default())))
        .manage(MdChannel(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![bridge_message, get_markdown_result])
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .setup(|app| {
            let handle = app.handle().clone();

            // Recent files + a file passed on the command line (opened on `ready`).
            let recent = load_recent(&handle);
            {
                let st = handle.state::<AppState>();
                let mut g = st.0.lock().unwrap();
                g.recent = recent.clone();
                g.pending_path = first_file_arg(&std::env::args().collect::<Vec<_>>());
            }

            // Window with the bridge/find init script attached.
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Untitled")
                .inner_size(900.0, 720.0)
                .min_inner_size(480.0, 360.0)
                .center()
                .initialization_script(INIT_SCRIPT)
                .build()?;

            let h = handle.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    guard_then(&h, AfterSave::Close);
                }
            });

            let menu = build_menu(&handle, &recent)?;
            app.set_menu(menu)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Markwise");
}
