// Agent Room Desktop shell (design §2): window + tray + local settings page.
// The shell owns no business logic. It starts/stops the Node daemon and shows
// webviews: the remote web app (no IPC), the daemon's 127.0.0.1 settings page,
// and optional terminal-<seatId> pop-out windows (localhost IPC only).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
#[cfg(windows)]
use std::sync::OnceLock;

/// WebView2 Environment is a COM pointer (not Sync/Send in the Windows crates).
/// Tauri creates/uses it on the UI thread; we only share the same Environment across
/// top-level windows (Plan A). Marking Send+Sync is required for a process-wide OnceLock.
#[cfg(windows)]
struct SharedWebViewEnv(webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment);

#[cfg(windows)]
unsafe impl Send for SharedWebViewEnv {}
#[cfg(windows)]
unsafe impl Sync for SharedWebViewEnv {}

#[cfg(windows)]
static SHARED_WEBVIEW_ENV: OnceLock<SharedWebViewEnv> = OnceLock::new();
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::webview::PageLoadEvent;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Set before exit so the main window's hide-on-close does not cancel quit.
static QUITTING: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct DaemonInner {
    child: Option<Child>,
    control_url: Option<String>,
}

#[derive(Clone, Default)]
struct Daemon(Arc<Mutex<DaemonInner>>);

fn config_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()))
                    .join("AppData")
                    .join("Roaming")
            });
        return base.join("agent-room");
    }
    #[cfg(not(windows))]
    {
        let base = std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".config")
            });
        base.join("agent-room")
    }
}

/// Server URL: $AGENT_ROOM_SERVER > ~/.config/agent-room/desktop.json {"serverUrl"} > production.
fn server_url() -> String {
    if let Ok(v) = std::env::var("AGENT_ROOM_SERVER") {
        if !v.is_empty() {
            return v;
        }
    }
    if let Ok(raw) = std::fs::read_to_string(config_dir().join("desktop.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(s) = v.get("serverUrl").and_then(|s| s.as_str()) {
                return s.to_string();
            }
        }
    }
    "https://ai-room.pupgo.top".to_string()
}

fn daemon_script(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AGENT_ROOM_DAEMON_SCRIPT") {
        return Some(PathBuf::from(p));
    }
    let candidates = [
        app.path()
            .resource_dir()
            .ok()
            .map(|d| d.join("daemon").join("agent-room-daemon.mjs")),
        std::env::current_exe().ok().and_then(|e| {
            e.parent()
                .map(|p| p.join("daemon").join("agent-room-daemon.mjs"))
        }),
    ];
    candidates.into_iter().flatten().find(|p| p.exists())
}

fn path_has_node(dir: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    let name = "node.exe";
    #[cfg(not(windows))]
    let name = "node";
    let p = dir.join(name);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

fn node_file_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// Bundled runtime next to the installed app, before PATH / nvm.
/// Windows: `node/node.exe`. Linux: `node/node` (also `node/bin/node`).
fn bundled_node_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let name = node_file_name();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            roots.push(exe_dir.to_path_buf());
            roots.push(exe_dir.join("resources"));
        }
    }
    let mut out = Vec::new();
    for root in roots {
        out.push(root.join("node").join(name));
        if !cfg!(windows) {
            out.push(root.join("node").join("bin").join("node"));
        }
    }
    out
}

/// Resolve Node for GUI apps (nvm PATH often missing). Prefer absolute path.
/// Order: `AGENT_ROOM_NODE`, bundled runtime, then PATH / nvm / Program Files.
fn find_node(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(v) = std::env::var("AGENT_ROOM_NODE") {
        if !v.is_empty() {
            let p = PathBuf::from(&v);
            if p.is_file() {
                return Ok(p);
            }
            // Bare command name — try PATH lookup below after recording preference.
            if !v.contains('/') && !v.contains('\\') {
                if let Some(found) = which_on_path(&v) {
                    return Ok(found);
                }
            }
            return Err(format!(
                "AGENT_ROOM_NODE 指向的路径不存在: {v}\n请改成 node.exe 的完整路径，例如 C:\\nvm4w\\nodejs\\node.exe"
            ));
        }
    }

    for candidate in bundled_node_candidates(app) {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    if let Some(p) = which_on_path(if cfg!(windows) { "node.exe" } else { "node" }) {
        return Ok(p);
    }
    // Some environments only have `node` without extension on PATH lookups.
    if cfg!(windows) {
        if let Some(p) = which_on_path("node") {
            return Ok(p);
        }
    }

    #[cfg(windows)]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
        for key in ["NVM_SYMLINK", "NVM_HOME"] {
            if let Ok(v) = std::env::var(key) {
                if !v.is_empty() {
                    candidates.push(PathBuf::from(&v));
                    candidates.push(PathBuf::from(&v).join("nodejs"));
                }
            }
        }
        candidates.push(PathBuf::from(r"C:\nvm4w\nodejs"));
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(pf).join("nodejs"));
        }
        if let Ok(pf) = std::env::var("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(pf).join("nodejs"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(&local).join("Programs").join("nodejs"));
            candidates.push(PathBuf::from(&local).join("fnm"));
        }
        for dir in candidates {
            if let Some(p) = path_has_node(&dir) {
                return Ok(p);
            }
        }
    }

    Err(
        "未找到 Node.js。安装包应在 resources/node 中自带运行时；该文件不存在，PATH / nvm 中也没有可用的 node。\n\
         请重新安装 Agent Room，或设置用户环境变量 AGENT_ROOM_NODE 为 node 可执行文件的完整路径后重新打开。"
            .into(),
    )
}

fn is_unsafe_log_dir_text(text: &str) -> bool {
    if text.is_empty() || text == "." || text.starts_with(".\\") || text.starts_with("./") {
        return true;
    }
    if text.contains("\\.\\") || text.contains("/./") {
        return true;
    }
    let bytes = text.as_bytes();
    let windows_abs = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let unc = text.starts_with("\\\\") || text.starts_with("//");
    let posix_abs = text.starts_with('/');
    !(windows_abs || unc || posix_abs)
}

fn is_unsafe_log_dir(path: &Path) -> bool {
    is_unsafe_log_dir_text(&path.to_string_lossy())
}

fn ensure_writable_dir(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-probe");
    match OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// First safe, writable candidate. Relative `.\.agent-room` is never created.
fn choose_log_dir(candidates: &[Option<PathBuf>]) -> PathBuf {
    for candidate in candidates.iter().flatten() {
        if is_unsafe_log_dir(candidate) {
            continue;
        }
        if ensure_writable_dir(candidate) {
            return candidate.clone();
        }
    }
    let last = std::env::temp_dir().join("agent-room-logs");
    let _ = std::fs::create_dir_all(&last);
    last
}

fn fallback_log_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let base = std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|value| !value.is_empty())?;
        return Some(for_node_argv(
            PathBuf::from(base).join("agent-room").join("logs"),
        ));
    }
    #[cfg(not(windows))]
    {
        let base = std::env::var("HOME")
            .ok()
            .filter(|value| !value.is_empty())?;
        Some(
            PathBuf::from(base)
                .join(".local")
                .join("state")
                .join("agent-room")
                .join("logs"),
        )
    }
}

/// `<exe dir>\logs` (daemon.log and st_*.log). Falls back when that dir is not writable.
/// `AGENT_ROOM_STATE_DIR`, when set to an absolute path, wins.
fn daemon_log_dir() -> PathBuf {
    let from_env = std::env::var("AGENT_ROOM_STATE_DIR")
        .ok()
        .filter(|value| !value.is_empty())
        .map(|value| for_node_argv(PathBuf::from(value)));
    let install = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| for_node_argv(dir.to_path_buf())))
        .map(|dir| dir.join("logs"));
    choose_log_dir(&[from_env, install, fallback_log_dir()])
}

fn daemon_log_path() -> PathBuf {
    daemon_log_dir().join("daemon.log")
}

fn open_daemon_log() -> Result<std::fs::File, String> {
    let dir = daemon_log_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建日志目录 {}: {e}", dir.display()))?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(daemon_log_path())
        .map_err(|e| format!("无法打开日志 {}: {e}", daemon_log_path().display()))
}

fn shell_log(line: &str) {
    if let Ok(mut file) = open_daemon_log() {
        let _ = writeln!(file, "{} {}", log_stamp(), line);
    }
}

fn log_stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let tod = secs % 86400;
    let hour = tod / 3600;
    let min = (tod % 3600) / 60;
    let sec = tod % 60;
    // Howard Hinnant civil_from_days, for dates after 1970-01-01.
    let z = days + 719468;
    let era = z / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}Z")
}

fn tail_lines(path: &Path, max_lines: usize) -> String {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return String::new(),
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(64 * 1024);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        if let Some(i) = text.find('\n') {
            text.drain(..=i);
        }
    }
    let lines: Vec<&str> = text.lines().collect();
    let from = lines.len().saturating_sub(max_lines);
    let mut out = lines[from..].join("\n");
    const MAX_CHARS: usize = 3500;
    if out.chars().count() > MAX_CHARS {
        let skip = out.chars().count() - MAX_CHARS;
        out = out.chars().skip(skip).collect();
        out.insert_str(0, "…\n");
    }
    out
}

fn which_on_path(cmd: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if let Some(p) = path_has_node(&dir) {
            // If cmd is node.exe and we found node.exe, or exact name match.
            if p.file_name().and_then(|s| s.to_str()) == Some(cmd)
                || (cfg!(windows)
                    && cmd == "node"
                    && p.file_name().and_then(|s| s.to_str()) == Some("node.exe"))
            {
                return Some(p);
            }
            if cmd == "node" || cmd == "node.exe" {
                return Some(p);
            }
        }
        // Also accept exact file in dir named cmd
        let direct = dir.join(cmd);
        if direct.is_file() {
            return Some(direct);
        }
    }
    None
}

fn alert(title: &str, message: &str) {
    // Visible even with windows_subsystem = "windows" (unlike eprintln!).
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        fn wide(s: &str) -> Vec<u16> {
            OsStr::new(s).encode_wide().chain(Some(0)).collect()
        }
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(
                hwnd: *mut core::ffi::c_void,
                text: *const u16,
                caption: *const u16,
                flags: u32,
            ) -> i32;
        }
        const MB_OK: u32 = 0x0000_0000;
        const MB_ICONERROR: u32 = 0x0000_0010;
        let text = wide(message);
        let caption = wide(title);
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                caption.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
        return;
    }
    #[cfg(not(windows))]
    {
        eprintln!("{title}: {message}");
        let _ = Command::new("zenity")
            .args(["--error", "--title", title, "--text", message, "--no-wrap"])
            .status();
    }
}

/// `true` when closing `main` should hide to the tray instead of exiting.
fn main_should_hide_on_close(label: &str, quitting: bool) -> bool {
    label == "main" && !quitting
}

/// Pop-out labels get an explicit destroy. During quit the process exit closes them.
fn terminal_should_force_destroy(label: &str, quitting: bool) -> bool {
    !quitting && label.starts_with("terminal-")
}

/// Pick the WebView2/WebKit user-data folder for a window label.
///
/// `main` keeps the historical app data dir (remote room origin cookies).
/// `settings` uses `local-settings`. Each `terminal-*` pop-out gets its own
/// sibling folder named after the window label. wry builds a new
/// CoreWebView2 Environment per WebView even when Tauri reuses a
/// WebContext for the same `data_directory`; a second Environment on an
/// in-use user-data folder never finishes the first navigation (0.1.24's
/// shared `local-control` left Windows pop-outs on the empty background).
/// Sharing one folder among terminals would hit the same footgun when two
/// seats are popped. Per-seat folders are safe again because the pop-out
/// boots from a `data:` document that paints before the loopback hop.
/// Never reuse `main`'s folder for localhost windows (a second controller
/// on that Environment stayed blank in 0.1.22).
fn webview_profile_key(label: &str) -> &str {
    if label == "main" {
        "main"
    } else if label == "settings" {
        "local-settings"
    } else if label.starts_with("terminal-") {
        label
    } else {
        label
    }
}

fn webview_profile_dir(root: &Path, label: &str) -> PathBuf {
    let key = webview_profile_key(label);
    if key == "main" {
        return root.to_path_buf();
    }
    let mut safe = String::new();
    for c in key.chars() {
        let next = if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            c
        } else {
            '_'
        };
        safe.push(next);
        if safe.len() >= 96 {
            break;
        }
    }
    if safe.is_empty() {
        safe.push_str("window");
    }
    let parent = root.parent().unwrap_or(root);
    let folder = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("webview");
    parent.join(format!("{folder}-profiles")).join(safe)
}

fn webview_data_directory(app: &AppHandle, label: &str) -> Result<Option<PathBuf>, String> {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("无法确定 WebView 持久化目录: {e}"))?;
        // Windows windows share the main WebView2 Environment. Its user-data
        // folder must match on every builder using that Environment.
        #[cfg(windows)]
        let dir = root;
        #[cfg(not(windows))]
        let dir = webview_profile_dir(&root, label);
        #[cfg(windows)]
        let _ = label;
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("无法创建 WebView 目录 {}: {e}", dir.display()))?;
        Ok(Some(dir))
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        // WKWebView uses its persistent default website data store on macOS;
        // Tauri's data_directory setting is unavailable there.
        let _ = (app, label);
        Ok(None)
    }
}

fn parse_daemon_lock_pid(text: &str) -> Option<u32> {
    let pid = text.trim().parse::<u32>().ok()?;
    if pid == 0 {
        None
    } else {
        Some(pid)
    }
}

fn seat_pids_from_daemon_state(text: &str) -> Vec<u32> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(seats) = value.get("seats").and_then(|entry| entry.as_array()) else {
        return Vec::new();
    };
    let mut pids = Vec::new();
    for seat in seats {
        let Some(pid) = seat.get("pid").and_then(|entry| entry.as_u64()) else {
            continue;
        };
        if (1..=u64::from(u32::MAX)).contains(&pid) {
            pids.push(pid as u32);
        }
    }
    pids
}

/// Pids to hard-kill on quit: spawned node, daemon.lock owner, and seat CLIs.
/// Never includes this process.
fn pids_to_kill(
    self_pid: u32,
    child: Option<u32>,
    lock_pid: Option<u32>,
    seat_pids: &[u32],
) -> Vec<u32> {
    let mut pids = Vec::new();
    if let Some(pid) = child {
        pids.push(pid);
    }
    if let Some(pid) = lock_pid {
        pids.push(pid);
    }
    pids.extend(seat_pids.iter().copied());
    pids.retain(|pid| *pid != 0 && *pid != self_pid);
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// Kill `pid` and descendants. Windows: `taskkill /F /T`. Unix: process group
/// (daemon is spawned with `process_group(0)`) and the pid itself. Seat CLIs
/// that called `setsid` are killed when their pid is passed in separately.
fn terminate_pid_tree(pid: u32) {
    if pid == 0 || pid == std::process::id() {
        return;
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .status();
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
    }
}

fn main_window_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let settings = MenuItem::with_id(app, "window-settings", "本机设置", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let app_menu =
        Submenu::with_items(app, "Agent Room", true, &[&settings]).map_err(|e| e.to_string())?;
    Menu::with_items(app, &[&app_menu]).map_err(|e| e.to_string())
}

fn open_settings_window(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = url
        .parse()
        .map_err(|e| format!("本机设置地址无效: {e}\n{url}"))?;
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // Same daemon session keeps the control token; raising is enough.
        return Ok(());
    }
    let mut builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::External(parsed));
    if let Some(data_dir) = webview_data_directory(app, "settings")? {
        builder = builder.data_directory(data_dir);
    }
    #[cfg(windows)]
    {
        let env = SHARED_WEBVIEW_ENV.get().ok_or("WebView2 环境尚未就绪")?;
        builder = builder.with_environment(env.0.clone());
    }
    builder
        .title("Agent Room · 本机设置")
        .inner_size(900.0, 720.0)
        .build()
        .map_err(|e| format!("无法打开本机设置窗口: {e}"))?;
    Ok(())
}

const DAEMON_READY_TIMEOUT: Duration = Duration::from_secs(30);

fn close_labeled_window(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if label.starts_with("terminal-") {
        force_close_terminal(app, label);
    } else {
        let _ = window.close();
    }
}

/// `destroy` skips `Destroyed`, so dock the seat before tearing the window down.
fn force_close_terminal(app: &AppHandle, label: &str) {
    if let Some(seat_id) = take_terminal_seat(label) {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.emit("managed-terminal-docked", seat_id);
        }
    }
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
}

static TERMINAL_SEAT_BY_LABEL: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn remember_terminal_seat(label: &str, seat_id: &str) {
    if let Ok(mut map) = TERMINAL_SEAT_BY_LABEL.lock() {
        map.insert(label.to_string(), seat_id.to_string());
    }
}

fn take_terminal_seat(label: &str) -> Option<String> {
    TERMINAL_SEAT_BY_LABEL.lock().ok()?.remove(label)
}

/// Sanitize seat id into a Tauri window label (`terminal-<safe>`).
/// Mirrors `tools/wake-agent/src/terminalWindow.ts`.
fn terminal_window_label(seat_id: &str) -> String {
    let mut safe = String::new();
    let mut last_underscore = false;
    for c in seat_id.trim().chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || c == '_';
        let next = if ok { c } else { '_' };
        if next == '_' {
            if last_underscore || safe.is_empty() {
                continue;
            }
            last_underscore = true;
            safe.push('_');
        } else {
            last_underscore = false;
            safe.push(next);
        }
        if safe.len() >= 96 {
            break;
        }
    }
    while safe.ends_with('_') {
        safe.pop();
    }
    if safe.is_empty() {
        safe.push_str("seat");
    }
    format!("terminal-{safe}")
}

const TERM_MIN_W: f64 = 480.0;
const TERM_MIN_H: f64 = 320.0;
const TERM_DEFAULT_W: f64 = 960.0;
const TERM_DEFAULT_H: f64 = 640.0;
const TERM_MAX_W: f64 = 3840.0;
const TERM_MAX_H: f64 = 2160.0;

/// Logical size used by `open_terminal_window`. Non-finite values fall back to defaults.
fn clamp_terminal_size(width: f64, height: f64) -> (f64, f64) {
    let width = if width.is_finite() {
        width.clamp(TERM_MIN_W, TERM_MAX_W)
    } else {
        TERM_DEFAULT_W
    };
    let height = if height.is_finite() {
        height.clamp(TERM_MIN_H, TERM_MAX_H)
    } else {
        TERM_DEFAULT_H
    };
    (width, height)
}

/// Logical origin. `None` when either coordinate is missing or non-finite.
fn clamp_terminal_position(x: Option<f64>, y: Option<f64>) -> Option<(f64, f64)> {
    match (x, y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => {
            Some((x.clamp(-8000.0, 16000.0), y.clamp(-8000.0, 16000.0)))
        }
        _ => None,
    }
}

/// Seat ids that can be placed in the pop-out query. Same alphabet as
/// `terminal_window_label`, but rejected instead of rewritten so the PTY id stays exact.
fn validate_managed_seat_id(seat_id: &str) -> Result<&str, String> {
    let seat_id = seat_id.trim();
    if seat_id.is_empty() {
        return Err("seatId required".into());
    }
    if seat_id.len() > 128 {
        return Err("seatId too long".into());
    }
    if !seat_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("seatId has invalid characters".into());
    }
    Ok(seat_id)
}

fn query_encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn form_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        if percent_decode(raw_key) == key {
            return Some(percent_decode(raw_value));
        }
    }
    None
}

/// Origin + `t` token from daemon stdout `control: <url>`.
/// Only loopback http is accepted, matching `open_terminal_window`.
fn control_origin_and_token(control_url: &str) -> Result<(String, String), String> {
    let control_url = control_url.trim();
    let (prefix, rest) = if let Some(rest) = control_url.strip_prefix("http://127.0.0.1:") {
        ("http://127.0.0.1:", rest)
    } else if let Some(rest) = control_url.strip_prefix("http://localhost:") {
        ("http://localhost:", rest)
    } else {
        return Err("控制页地址必须是 http://127.0.0.1 或 http://localhost".into());
    };
    let port_len = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if port_len == 0 {
        return Err("控制页地址缺少端口".into());
    }
    let port = &rest[..port_len];
    let after = &rest[port_len..];
    let query = if let Some((path, query)) = after.split_once('?') {
        if !(path.is_empty() || path.starts_with('/')) {
            return Err("控制页地址无效".into());
        }
        query.split('#').next().unwrap_or("")
    } else {
        return Err("控制页地址缺少令牌".into());
    };
    let token = form_param(query, "t")
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "控制页地址缺少令牌".to_string())?;
    Ok((format!("{prefix}{port}"), token))
}

/// Same query shape as `buildPopoutControlUrl` / settings.html `buildPopoutUrl`.
fn managed_terminal_popout_url(control_url: &str, seat_id: &str) -> Result<String, String> {
    let seat_id = validate_managed_seat_id(seat_id)?;
    let (origin, token) = control_origin_and_token(control_url)?;
    Ok(format!(
        "{origin}/?t={}&terminal={}&popout=1",
        query_encode(&token),
        query_encode(seat_id),
    ))
}

fn open_managed_terminal_url(control_url: Option<&str>, seat_id: &str) -> Result<String, String> {
    let control_url = control_url
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| {
            "本机后台尚未就绪（没有控制页地址）。请确认桌面端已打开并稍后再试。".to_string()
        })?;
    managed_terminal_popout_url(control_url, seat_id)
}

fn html_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// Single-quoted JS string. Escapes quotes, controls, and `<` so the value
/// cannot close the surrounding `<script>` when the control URL is embedded.
fn js_single_quoted(value: &str) -> String {
    let mut out = String::from("'");
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '<' => out.push_str("\\u003c"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// Origin shown if the boot page is still up after ~8s. Never includes `t`.
fn control_origin_label(control_url: &str) -> String {
    let raw = control_origin_and_token(control_url)
        .map(|(origin, _)| origin)
        .unwrap_or_else(|_| {
            control_url
                .split(['?', '#'])
                .next()
                .unwrap_or(control_url)
                .trim()
                .to_string()
        });
    const MAX_CHARS: usize = 64;
    let mut chars = raw.chars();
    let truncated: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn terminal_boot_document(seat_id: &str, control_url: &str) -> String {
    let origin = control_origin_label(control_url);
    let mut html = String::new();
    html.push_str(
        "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>Agent Room</title><style>",
    );
    html.push_str("html,body{margin:0;height:100%;background:#1e1e1e;color:#c4c7cc}");
    html.push_str(
        "body{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px}",
    );
    html.push_str("#err{display:none;color:#f28b82;margin-top:12px;white-space:pre-wrap}");
    html.push_str("</style></head><body><div id=\"boot\">正在连接终端…<br>");
    html.push_str(&html_escape(seat_id));
    html.push_str("</div><div id=\"err\"></div><script>(function(){");
    html.push_str("var target=");
    html.push_str(&js_single_quoted(control_url));
    html.push_str(";var origin=");
    html.push_str(&js_single_quoted(&origin));
    html.push_str(";function go(){location.replace(target);}");
    html.push_str("requestAnimationFrame(function(){requestAnimationFrame(go);});");
    html.push_str("setTimeout(function(){var el=document.getElementById('err');");
    html.push_str("if(!el)return;el.style.display='block';");
    html.push_str("el.textContent='无法加载本机终端页\\n'+origin;},8000);");
    html.push_str("})();</script></body></html>");
    html
}

/// `data:` document that paints immediately, then hops to the loopback control URL.
/// Same percent-encoding style as `open_daemon_loading_window`.
fn terminal_boot_data_url(seat_id: &str, control_url: &str) -> String {
    format!(
        "data:text/html;charset=utf-8,{}",
        query_encode(&terminal_boot_document(seat_id, control_url))
    )
}

fn is_terminal_boot_scheme(scheme: &str) -> bool {
    // `about:blank` is the WebView's transient start URL. Treating it as the
    // boot document would `navigate` to the control page before the data:
    // document commits, which is the blank-window failure mode.
    scheme == "data"
}

/// Rust-side hop used when the boot document's `location.replace` does not run.
///
/// Called only after that document has finished loading. `navigate` before
/// then replaces the pending `data:` URL, and WebView2 stays on the empty
/// background color (the 0.1.25 black pop-out).
fn queue_terminal_control_navigate(window: tauri::WebviewWindow, control: tauri::Url) {
    std::thread::spawn(move || {
        // Leave a beat for the boot script's double-rAF replace and first paint.
        std::thread::sleep(Duration::from_millis(400));
        let app = window.app_handle().clone();
        let _ = app.run_on_main_thread(move || {
            let still_boot = window
                .url()
                .map(|current| is_terminal_boot_scheme(current.scheme()))
                .unwrap_or(false);
            if still_boot {
                shell_log(&format!("[popout] navigate fallback label={}", window.label()));
                if let Err(error) = window.navigate(control) {
                    shell_log(&format!("[popout] navigate failed label={} reason={error}", window.label()));
                }
            }
        });
    });
}

/// Schedule pop-out creation after the invoking IPC returns.
///
/// Room-page `open_managed_terminal` runs while the main WebView2 is mid-IPC on the
/// shared Environment. Building another controller on that stack hangs after
/// "[popout] create start" with a titled black window and never reaches create done.
/// Settings avoids this by opening from a worker thread + `run_on_main_thread`; mirror that.
fn schedule_terminal_popout(
    app: AppHandle,
    seat_id: String,
    url: String,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) {
    shell_log(&format!(
        "[popout] schedule seatId={seat_id} origin={}",
        control_origin_label(&url)
    ));
    std::thread::spawn(move || {
        // Let the Tauri invoke unwind before CreateCoreWebView2Controller.
        std::thread::sleep(Duration::from_millis(50));
        let app_main = app.clone();
        let seat = seat_id.clone();
        let url2 = url.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if let Err(err) =
                open_terminal_window_inner(&app_main, &seat, &url2, x, y, width, height)
            {
                shell_log(&format!(
                    "[popout] create failed seatId={seat} reason={err}"
                ));
            }
        }) {
            shell_log(&format!(
                "[popout] schedule main-thread failed seatId={seat_id} reason={error}"
            ));
        }
    });
}

fn open_terminal_window_inner(
    app: &AppHandle,
    seat_id: &str,
    url: &str,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let label = terminal_window_label(seat_id);
    shell_log(&format!(
        "[popout] create start seatId={seat_id} label={label} origin={}",
        control_origin_label(url)
    ));
    let control: tauri::Url = url
        .parse()
        .map_err(|e| format!("终端窗口地址无效: {e}\n{url}"))?;
    // Never navigate a wedged black pop-out: navigate() can hang on shared
    // WebView2 the same way build() did. Destroy and recreate instead.
    if app.get_webview_window(&label).is_some() {
        shell_log(&format!(
            "[popout] destroy existing before recreate seatId={seat_id} label={label}"
        ));
        close_labeled_window(app, &label);
    }
    let (width, height) = clamp_terminal_size(
        width.unwrap_or(TERM_DEFAULT_W),
        height.unwrap_or(TERM_DEFAULT_H),
    );
    // Windows: open the loopback control URL directly (same path as settings).
    // data: boot + shared WebView2 env has hung after "create start" with a black window.
    #[cfg(windows)]
    let initial = WebviewUrl::External(control.clone());
    #[cfg(not(windows))]
    let initial = {
        let boot = terminal_boot_data_url(seat_id, url);
        let boot_url = boot.parse().map_err(|e| format!("终端启动页无效: {e}"))?;
        WebviewUrl::External(boot_url)
    };
    let mut builder = WebviewWindowBuilder::new(app, &label, initial);
    if let Some(data_dir) = webview_data_directory(app, &label)? {
        builder = builder.data_directory(data_dir);
    }
    #[cfg(windows)]
    {
        let env = SHARED_WEBVIEW_ENV.get().ok_or("WebView2 环境尚未就绪")?;
        builder = builder.with_environment(env.0.clone());
    }
    builder = builder
        .title(format!("Agent Room · {seat_id}"))
        .inner_size(width, height)
        .min_inner_size(TERM_MIN_W, TERM_MIN_H)
        .background_color(Color(0x1e, 0x1e, 0x1e, 255));
    if let Some((x, y)) = clamp_terminal_position(x, y) {
        builder = builder.position(x, y);
    }
    shell_log(&format!("[popout] build begin seatId={seat_id} label={label}"));
    #[cfg(windows)]
    let created = builder
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            shell_log(&format!(
                "[popout] page loaded label={} scheme={}",
                window.label(),
                payload.url().scheme()
            ));
        })
        .build()
        .map_err(|e| format!("无法打开终端窗口: {e}"))?;
    #[cfg(not(windows))]
    let created = builder
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            if !is_terminal_boot_scheme(payload.url().scheme()) {
                shell_log(&format!("[popout] page loaded label={} scheme={}", window.label(), payload.url().scheme()));
                return;
            }
            shell_log(&format!("[popout] boot loaded label={}", window.label()));
            // After show + boot-document commit. Synchronous navigate() from
            // build() would cancel this data: URL before it paints.
            queue_terminal_control_navigate(window, control.clone());
        })
        .build()
        .map_err(|e| format!("无法打开终端窗口: {e}"))?;
    remember_terminal_seat(&label, seat_id);
    let _ = created.unminimize();
    let _ = created.show();
    let _ = created.set_focus();
    shell_log(&format!("[popout] create done seatId={seat_id} label={label}"));
    Ok(())
}

#[tauri::command]
fn open_terminal_window(
    app: AppHandle,
    seat_id: String,
    url: String,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    if seat_id.trim().is_empty() {
        return Err("seatId required".into());
    }
    if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")) {
        return Err("terminal pop-out URL must be http://127.0.0.1 or http://localhost".into());
    }
    schedule_terminal_popout(app, seat_id, url, x, y, width, height);
    Ok(())
}

/// Open the embedded PTY pop-out for a seat the desktop daemon just hosted.
/// The room page supplies only `seatId`. The control token never leaves this process.
#[tauri::command]
fn open_managed_terminal(
    app: AppHandle,
    daemon: tauri::State<'_, Daemon>,
    seat_id: String,
) -> Result<(), String> {
    let seat = seat_id.trim().to_string();
    if seat.is_empty() {
        return Err("seatId required".into());
    }
    let url = open_managed_terminal_url(daemon.control_url().as_deref(), &seat)?;
    schedule_terminal_popout(app, seat, url, None, None, None, None);
    Ok(())
}

#[tauri::command]
fn close_terminal_window(app: AppHandle, seat_id: String) -> Result<(), String> {
    if seat_id.trim().is_empty() {
        return Err("seatId required".into());
    }
    let label = terminal_window_label(&seat_id);
    close_labeled_window(&app, &label);
    Ok(())
}

fn open_daemon_loading_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("daemon-loading").is_some() {
        return Ok(());
    }
    let html = concat!(
        "data:text/html;charset=utf-8,",
        "%3C!DOCTYPE%20html%3E%3Chtml%20lang%3Dzh-CN%3E%3Chead%3E%3Cmeta%20charset%3Dutf-8%3E",
        "%3Ctitle%3Eloading%3C/title%3E%3Cstyle%3E",
        "body%7Bmargin%3A0%3Bfont%3A15px/1.5%20system-ui%2Csans-serif%3Bdisplay%3Agrid%3Bplace-items%3Acenter%3Bheight%3A100vh%3Bbackground%3A%23f4f5f7%3Bcolor%3A%231c1d1f%7D",
        ".box%7Btext-align%3Acenter%7D.spin%7Bwidth%3A28px%3Bheight%3A28px%3Bmargin%3A0%20auto%2012px%3Bborder%3A3px%20solid%20%23c5c8ce%3Bborder-top-color%3A%231f4b99%3Bborder-radius%3A50%25%3Banimation%3As%20.8s%20linear%20infinite%7D",
        "%40keyframes%20s%7Bto%7Btransform%3Arotate(360deg)%7D%7D%3C/style%3E%3C/head%3E%3Cbody%3E%3Cdiv%20class%3Dbox%3E%3Cdiv%20class%3Dspin%3E%3C/div%3E",
        "%3Cdiv%3E%E6%AD%A3%E5%9C%A8%E8%BF%9E%E6%8E%A5%E6%9C%AC%E6%9C%BA%E5%90%8E%E5%8F%B0%E2%80%A6%3C/div%3E",
        "%3Cp%20style%3Dcolor%3A%235c616a%3Bfont-size%3A13px%3E%E6%9C%80%E5%A4%9A%E7%AD%8930%E7%A7%92%3C/p%3E%3C/div%3E%3C/body%3E%3C/html%3E",
    );
    let parsed = html
        .parse()
        .map_err(|e| format!("loading url invalid: {e}"))?;
    WebviewWindowBuilder::new(app, "daemon-loading", WebviewUrl::External(parsed))
        .title("正在连接本机后台…")
        .inner_size(360.0, 160.0)
        .resizable(false)
        .build()
        .map_err(|e| format!("无法打开连接提示窗口: {e}"))?;
    Ok(())
}

/// Paths handed to Node (argv and `current_dir`).
///
/// Tauri `resource_dir()` can yield Win32 extended paths (`\\?\D:\Agent Room\...`).
/// Node's `realpathSync` then walks up to `lstat('D:')` and exits EISDIR when the
/// install directory contains spaces. Strip `\\?\` (and map `\\?\UNC\foo` → `\\foo`)
/// on Windows so the logged path and the spawned path are the same. No-op elsewhere.
fn for_node_argv(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(text) = path.to_str() {
            if let Some(stripped) = strip_win32_verbatim_prefix(text) {
                return PathBuf::from(stripped);
            }
        }
    }
    path
}

/// `{ "port", "token" }` from the daemon's `control.json` →
/// `http://127.0.0.1:<port>/?t=<token>` (same shape as stdout `control: `).
/// `None` when a field is missing, the port is out of range, or the token is empty.
fn control_url_from_json(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let port = value.get("port")?.as_u64()?;
    if !(1..=65535).contains(&port) {
        return None;
    }
    let token = value.get("token")?.as_str()?.trim();
    if token.is_empty() || token.len() > 256 {
        return None;
    }
    if token.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    Some(format!(
        "http://127.0.0.1:{port}/?t={}",
        query_encode(token)
    ))
}

fn persisted_control_url(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("control.json")).ok()?;
    control_url_from_json(&text)
}

fn control_loopback_addr(origin: &str) -> Option<std::net::SocketAddr> {
    let hostport = origin.strip_prefix("http://")?;
    let (host, port) = hostport.rsplit_once(':')?;
    if host != "127.0.0.1" && host != "localhost" {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some(std::net::SocketAddr::from((
        std::net::Ipv4Addr::LOCALHOST,
        port,
    )))
}

fn http_status_is_ok(head: &str) -> bool {
    let line = head.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    let version = parts.next().unwrap_or("");
    let status = parts.next().unwrap_or("");
    version.starts_with("HTTP/1.") && status == "200"
}

/// GET `/api/terminals?t=` on the control URL. That route already exists and
/// rejects a bad token with 401. Only HTTP 200 counts as a live daemon.
fn probe_control_alive(control_url: &str) -> bool {
    let Ok((origin, token)) = control_origin_and_token(control_url) else {
        return false;
    };
    let Some(addr) = control_loopback_addr(&origin) else {
        return false;
    };
    let path = format!("/api/terminals?t={}", query_encode(&token));
    let host = origin.trim_start_matches("http://");
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    let timeout = Duration::from_secs(2);
    let mut stream = match std::net::TcpStream::connect_timeout(&addr, timeout) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return false,
    };
    http_status_is_ok(&String::from_utf8_lossy(&buf[..n]))
}

/// `\\?\D:\rest` → `D:\rest`; `\\?\UNC\server\share\rest` → `\\server\share\rest`.
/// `None` when `path` has no verbatim prefix, or the prefix would strip to empty.
#[cfg(any(windows, test))]
fn strip_win32_verbatim_prefix(path: &str) -> Option<String> {
    let rest = path.strip_prefix(r"\\?\")?;
    if rest.is_empty() {
        return None;
    }
    // `\\?\` is already gone. `UNC\server\...` must become `\\server\...`.
    if let Some(unc) = rest.strip_prefix(r"UNC\") {
        if unc.is_empty() {
            return None;
        }
        return Some(format!(r"\\{unc}"));
    }
    Some(rest.to_string())
}

impl Daemon {
    fn running(&self) -> bool {
        let mut g = self.0.lock().unwrap();
        match g.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Use a daemon that already holds this state dir. Keeps its token in-process
    /// and does not spawn or kill. `false` when `control.json` is missing or the
    /// endpoint does not answer 200.
    fn adopt_live_control(&self) -> bool {
        if let Some(url) = self.control_url() {
            if probe_control_alive(&url) {
                return true;
            }
        }
        let Some(url) = persisted_control_url(&daemon_log_dir()) else {
            return false;
        };
        if !probe_control_alive(&url) {
            return false;
        }
        self.0.lock().unwrap().control_url = Some(url.clone());
        if let Ok(mut log) = open_daemon_log() {
            let origin = control_origin_and_token(&url)
                .map(|(origin, _)| origin)
                .unwrap_or_else(|_| "http://127.0.0.1".into());
            let _ = writeln!(
                log,
                "----- {} adopt existing daemon {origin} -----",
                log_stamp()
            );
        }
        true
    }

    fn start(&self, app: &AppHandle) -> Result<(), String> {
        if self.running() {
            return Ok(());
        }
        // Another process already serves this state dir (lock + port). Adopt it
        // instead of spawning a second node that exits 1 on the lock.
        if self.adopt_live_control() {
            return Ok(());
        }
        // Strip before log and spawn so daemon.log matches the argv Node receives.
        let script = for_node_argv(daemon_script(app).ok_or_else(|| {
            "找不到本机后台脚本 daemon/agent-room-daemon.mjs（安装包不完整？）".to_string()
        })?);
        let node = for_node_argv(find_node(app)?);
        let cwd = script
            .parent()
            .filter(|dir| dir.is_dir())
            .map(|dir| for_node_argv(dir.to_path_buf()));
        let log_dir = daemon_log_dir();
        let mut log = open_daemon_log()?;
        let _ = writeln!(
            log,
            "----- {} daemon start -----\nnode: {}\nscript: {}\ncwd: {}\nstate: {}",
            log_stamp(),
            node.display(),
            script.display(),
            cwd.as_ref()
                .map(|dir| dir.display().to_string())
                .unwrap_or_else(|| "(unchanged)".into()),
            log_dir.display(),
        );
        let _ = log.flush();
        let stderr = log
            .try_clone()
            .map_err(|e| format!("无法复制日志句柄: {e}"))?;
        let mut stdout_log = log
            .try_clone()
            .map_err(|e| format!("无法复制日志句柄: {e}"))?;
        drop(log);

        // argv, not a shell: paths with spaces stay a single argument.
        let mut cmd = Command::new(&node);
        cmd.arg(&script)
            .args(["serve", "--server", &server_url()])
            .env("AGENT_ROOM_STATE_DIR", &log_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(stderr));
        if let Some(dir) = &cwd {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        // Own process group so quit can kill the daemon tree without signaling us.
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "无法启动本机后台（Node: {}）: {e}\n日志: {}",
                node.display(),
                daemon_log_path().display()
            )
        })?;
        let stdout = child.stdout.take().ok_or("daemon stdout missing")?;
        {
            let mut g = self.0.lock().unwrap();
            if let Some(mut old) = g.child.take() {
                let _ = old.kill();
                let _ = old.wait();
            }
            g.child = Some(child);
            g.control_url = None;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = writeln!(stdout_log, "{line}");
                let _ = stdout_log.flush();
                if let Some(url) = line.strip_prefix("control: ") {
                    me.0.lock().unwrap().control_url = Some(url.trim().to_string());
                }
            }
            let _ = stdout_log.flush();
        });
        Ok(())
    }

    /// `Some(Some(code))` exited, `Some(None)` signal, `None` still running or absent.
    fn exited_code(&self) -> Option<Option<i32>> {
        let mut g = self.0.lock().unwrap();
        let child = g.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(status.code()),
            _ => None,
        }
    }

    fn early_exit_detail(&self) -> String {
        let code = match self.exited_code() {
            Some(Some(code)) => code.to_string(),
            Some(None) => "signal".into(),
            None => "unknown".into(),
        };
        let log_path = daemon_log_path();
        let tail = tail_lines(&log_path, 40);
        let tail = if tail.is_empty() {
            "(日志为空)".to_string()
        } else {
            tail
        };
        format!(
            "本机后台进程启动后退出（退出码: {code}）。\n日志: {}\n最近输出:\n{tail}",
            log_path.display()
        )
    }

    /// Hard-stop the spawned daemon and seat CLIs. Bounded: never `wait()`s
    /// forever, and does not hold the daemon mutex across the kill.
    fn stop(&self) {
        let child = {
            let mut g = self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            g.control_url = None;
            g.child.take()
        };
        let dir = daemon_log_dir();
        let state = std::fs::read_to_string(dir.join("daemon.json")).unwrap_or_default();
        let lock_text = std::fs::read_to_string(dir.join("daemon.lock")).unwrap_or_default();
        let child_pid = child.as_ref().map(|proc| proc.id());
        let pids = pids_to_kill(
            std::process::id(),
            child_pid,
            parse_daemon_lock_pid(&lock_text),
            &seat_pids_from_daemon_state(&state),
        );
        for pid in pids {
            terminate_pid_tree(pid);
        }
        let Some(mut child) = child else {
            return;
        };
        let _ = child.kill();
        let deadline = Instant::now() + Duration::from_millis(800);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            }
        }
    }

    fn control_url(&self) -> Option<String> {
        let url = self.0.lock().unwrap().control_url.clone()?;
        let url = url.trim().to_string();
        if url.is_empty() {
            None
        } else {
            Some(url)
        }
    }

    fn wait_control_url(&self, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(url) = self.control_url() {
                return Some(url);
            }
            // Child never started, or it exited because the lock was already held.
            // Adopting here is what keeps autostart and 本机设置 from alerting.
            if !self.running() || Instant::now() > deadline {
                return if self.adopt_live_control() {
                    self.control_url()
                } else {
                    None
                };
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let url = match server_url().parse() {
        Ok(u) => u,
        Err(e) => {
            alert("Agent Room", &format!("服务器地址无效: {e}"));
            return;
        }
    };
    let menu = match main_window_menu(app) {
        Ok(menu) => menu,
        Err(e) => {
            alert("Agent Room", &format!("无法创建主窗口菜单: {e}"));
            return;
        }
    };
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url));
    match webview_data_directory(app, "main") {
        Ok(Some(data_dir)) => builder = builder.data_directory(data_dir),
        Ok(None) => {}
        Err(e) => {
            alert("Agent Room", &e);
            return;
        }
    }
    match builder
        .title("Agent Room")
        .inner_size(1200.0, 800.0)
        .menu(menu)
        .build()
    {
        Ok(window) => {
            #[cfg(windows)]
            if let Err(error) = window.with_webview(|view| {
                let _ = SHARED_WEBVIEW_ENV.set(SharedWebViewEnv(view.environment()));
                shell_log("[popout] shared WebView2 environment ready");
            }) {
                shell_log(&format!("[popout] shared environment capture failed reason={error}"));
            }
            #[cfg(not(windows))]
            let _ = window;
        }
        Err(e) => alert("Agent Room", &format!("无法打开主窗口: {e}")),
    }
}

fn spawn_show_settings(app: &AppHandle, daemon: &Daemon) {
    let (app, daemon) = (app.clone(), daemon.clone());
    std::thread::spawn(move || show_settings(app, daemon));
}

fn report_autostart_readiness(daemon: Daemon) {
    if daemon.wait_control_url(DAEMON_READY_TIMEOUT).is_some() {
        return;
    }
    let detail = if daemon.running() {
        "本机后台进程已启动，但 30 秒内没有报告控制页地址。请确认安装包中的 daemon 文件完整，然后从主窗口菜单「本机设置」重试。"
            .to_string()
    } else {
        daemon.early_exit_detail()
    };
    alert("本机后台自动启动失败", &detail);
}

fn show_settings(app: AppHandle, daemon: Daemon) {
    if let Err(e) = daemon.start(&app) {
        alert("本机设置", &e);
        return;
    }
    let app_loading = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(err) = open_daemon_loading_window(&app_loading) {
            alert("本机设置", &err);
        }
    });
    let ready = daemon.wait_control_url(DAEMON_READY_TIMEOUT);
    let app_close = app.clone();
    let _ = app.run_on_main_thread(move || {
        close_labeled_window(&app_close, "daemon-loading");
    });
    let Some(url) = ready else {
        let hint = if daemon.running() {
            "本机后台已启动，但 30 秒内未报到控制页地址（control: URL）。\n请查看安装目录下 daemon 是否完整，或重新打开主窗口菜单「本机设置」重试。"
                .to_string()
        } else {
            format!(
                "{}\n\n可从主窗口菜单或托盘菜单选择「启动后台程序」重试。",
                daemon.early_exit_detail()
            )
        };
        alert("本机设置", &hint);
        return;
    };

    let app2 = app.clone();
    let url2 = url.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Err(err) = open_settings_window(&app2, &url2) {
            alert("本机设置", &err);
        }
    }) {
        alert(
            "本机设置",
            &format!("无法在主线程打开设置窗口: {e}\n控制页: {url}"),
        );
    }
}

/// How long the quit watchdog waits before `process::exit` if `app.exit` stalls
/// (wedged WebView2 destroy / RunEvent loop).
const QUIT_WATCHDOG_MS: u64 = 2_000;

/// Windows: delay before an external `taskkill /F /T` of this pid, in case the
/// process is frozen hard enough that the in-process watchdog never runs.
/// Tray 退出 must not wait on `WebviewWindow::destroy` (wedged WebView2 can
/// hang forever and leave a dead tray/taskbar icon). Order:
/// 1) QUITTING so hide-on-close cannot cancel exit
/// 2) remove tray so Shell_NotifyIcon NIM_DELETE runs before hard exit
/// 3) kill daemon + seat CLIs now (do not wait for RunEvent::Exit)
/// 4) hide windows only
/// 5) app.exit(0)
/// 6) in-process watchdog `process::exit`, plus Windows detached taskkill
fn request_quit(app: &AppHandle, daemon: &Daemon) {
    QUITTING.store(true, Ordering::SeqCst);
    shell_log("[tray] quit requested");
    schedule_quit_watchdog();
    // Drop closes the tray icon with the shell (avoids ghost icons after hard exit).
    let _ = app.remove_tray_by_id("main");
    daemon.stop();
    for window in app.webview_windows().into_values() {
        let _ = window.hide();
    }
    app.exit(0);
}

fn schedule_quit_watchdog() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(QUIT_WATCHDOG_MS));
        if QUITTING.load(Ordering::SeqCst) {
            std::process::exit(0);
        }
    });
}

fn main() {
    let daemon = Daemon::default();
    let daemon_for_exit = daemon.clone();
    tauri::Builder::default()
        .manage(daemon.clone())
        .invoke_handler(tauri::generate_handler![
            open_terminal_window,
            close_terminal_window,
            open_managed_terminal
        ])
        .on_menu_event({
            let menu_daemon = daemon.clone();
            move |app, event| {
                if event.id.as_ref() == "window-settings" {
                    spawn_show_settings(app, &menu_daemon);
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            if std::env::var("AGENT_ROOM_NO_DAEMON").is_err() {
                if let Err(e) = daemon.start(&handle) {
                    alert("本机后台自动启动失败", &e);
                } else {
                    let d = daemon.clone();
                    std::thread::spawn(move || report_autostart_readiness(d));
                }
            }
            let open = MenuItem::with_id(app, "open", "打开 Agent Room", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "本机设置", true, None::<&str>)?;
            let start = MenuItem::with_id(app, "start", "启动后台程序", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "停止后台程序", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu =
                Menu::with_items(app, &[&open, &settings, &sep, &start, &stop, &sep, &quit])?;
            let d = daemon.clone();
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("Agent Room")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "settings" => spawn_show_settings(app, &d),
                    "start" => {
                        if let Err(e) = d.start(app) {
                            alert("启动后台程序", &e);
                        }
                    }
                    "stop" => d.stop(),
                    "quit" => request_quit(app, &d),
                    _ => {}
                })
                .build(app)?;
            show_main(&handle);
            if std::env::var("AGENT_ROOM_OPEN_SETTINGS").is_ok() {
                spawn_show_settings(&handle, &daemon);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let quitting = QUITTING.load(Ordering::SeqCst);
            match event {
                // Closing the main window hides it; the tray keeps the app (and daemon) alive.
                // Quit must not take this branch: prevent_close cancels app.exit and the
                // tray item looks dead. Terminal close is forced because a WebView2 that
                // is still starting (blank pop-out) can ignore the default close.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let label = window.label().to_string();
                    if main_should_hide_on_close(&label, quitting) {
                        api.prevent_close();
                        let _ = window.hide();
                    } else if terminal_should_force_destroy(&label, quitting) {
                        // Prevent the default close: a wedged WebView2 ignores it and
                        // the window stays forever. Destroy synchronously on THIS
                        // handle — queueing via run_on_main_thread never ran while
                        // the Environment hung (0.1.23 black pop-out).
                        api.prevent_close();
                        let app = window.app_handle().clone();
                        force_close_terminal(&app, &label);
                        // force_close may no-op if the map lookup races; always
                        // destroy the CloseRequested window handle itself.
                        let _ = window.destroy();
                        if app.get_webview_window(&label).is_some() {
                            let _ = window.hide();
                            let label2 = label.clone();
                            let _ = app.clone().run_on_main_thread(move || {
                                force_close_terminal(&app, &label2);
                            });
                        }
                    }
                }
                // Pop-out is a different origin from the room page, so BroadcastChannel
                // cannot dock it. Tell the main webview to reattach the same PTY.
                tauri::WindowEvent::Destroyed => {
                    if let Some(seat_id) = take_terminal_seat(window.label()) {
                        if let Some(main) = window.app_handle().get_webview_window("main") {
                            let _ = main.emit("managed-terminal-docked", seat_id);
                        }
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                daemon_for_exit.stop();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview_profiles_are_siblings_of_the_main_folder() {
        let root = PathBuf::from("/tmp/com.agent-room.desktop");
        assert_eq!(webview_profile_dir(&root, "main"), root);
        let term = webview_profile_dir(&root, "terminal-st_1");
        let term2 = webview_profile_dir(&root, "terminal-st_2");
        let settings = webview_profile_dir(&root, "settings");
        assert_ne!(term, root);
        assert_ne!(
            term, term2,
            "each terminal pop-out gets its own WebView2 user-data folder"
        );
        assert_ne!(
            term, settings,
            "settings must not share a user-data folder with terminals"
        );
        assert!(!term.starts_with(&root));
        assert!(term.ends_with("terminal-st_1"));
        assert!(term2.ends_with("terminal-st_2"));
        assert!(settings.ends_with("local-settings"));
        assert_eq!(webview_profile_key("terminal-st_9"), "terminal-st_9");
        assert_eq!(webview_profile_key("settings"), "local-settings");
        assert_eq!(webview_profile_key("main"), "main");
    }

    #[test]
    fn terminal_boot_data_url_paints_seat_then_replaces_control_url() {
        let control = "http://127.0.0.1:17421/?t=secret-token&terminal=st_abc&popout=1";
        let data = terminal_boot_data_url("st_abc", control);
        assert!(data.starts_with("data:text/html;charset=utf-8,"));
        let html = percent_decode(data.strip_prefix("data:text/html;charset=utf-8,").unwrap());
        assert!(html.contains("st_abc"));
        assert!(html.contains("正在连接终端"));
        assert!(html.contains("#1e1e1e"));
        assert_eq!(html.matches("requestAnimationFrame").count(), 2);
        assert!(html.contains("location.replace"));
        assert!(html.contains(control));
        assert!(html.contains("无法加载本机终端页"));
        assert!(html.contains(",8000)"));
        let origin_js = html.split("var origin=").nth(1).unwrap();
        let origin_lit = origin_js.split(';').next().unwrap();
        assert_eq!(origin_lit, "'http://127.0.0.1:17421'");
        assert!(!origin_lit.contains("secret-token"));

        let escaped =
            terminal_boot_data_url("a<b>&\"c", "http://127.0.0.1:9/?t=t&terminal=a&popout=1");
        let escaped_html = percent_decode(
            escaped
                .strip_prefix("data:text/html;charset=utf-8,")
                .unwrap(),
        );
        assert!(escaped_html.contains("a&lt;b&gt;&amp;&quot;c"));
        assert!(!escaped_html.contains("a<b>"));
    }

    #[test]
    fn control_origin_label_drops_token_and_truncates() {
        assert_eq!(
            control_origin_label("http://127.0.0.1:17421/?t=secret&terminal=s&popout=1"),
            "http://127.0.0.1:17421"
        );
        assert_eq!(
            control_origin_label("http://localhost:9/?t=secret"),
            "http://localhost:9"
        );
        let long = format!("http://example.invalid/{}", "a".repeat(120));
        let label = control_origin_label(&long);
        assert!(label.chars().count() <= 65);
        assert!(label.ends_with('…'));
        assert!(!label.contains('?'));
    }

    #[test]
    fn close_policy_hides_main_until_quit_and_forces_terminal_destroy() {
        assert!(main_should_hide_on_close("main", false));
        assert!(!main_should_hide_on_close("main", true));
        assert!(!main_should_hide_on_close("terminal-st_1", false));
        assert!(terminal_should_force_destroy("terminal-st_1", false));
        assert!(!terminal_should_force_destroy("terminal-st_1", true));
        assert!(!terminal_should_force_destroy("main", false));
        assert!(!terminal_should_force_destroy("settings", false));
    }

    #[test]
    fn quit_watchdog_is_bounded() {
        assert!(QUIT_WATCHDOG_MS >= 500);
        assert!(QUIT_WATCHDOG_MS <= 5_000);
    }

    #[test]
    fn quit_kills_daemon_child_lock_owner_and_seat_pids_except_self() {
        let seats = seat_pids_from_daemon_state(
            r#"{"seats":[{"seatId":"st_1","pid":4242},{"seatId":"st_2"},{"pid":0},{"pid":7}]}"#,
        );
        assert_eq!(seats, vec![4242, 7]);
        assert_eq!(parse_daemon_lock_pid("  5150 \n"), Some(5150));
        assert_eq!(parse_daemon_lock_pid("0"), None);
        assert_eq!(parse_daemon_lock_pid("nope"), None);
        assert_eq!(
            pids_to_kill(100, Some(200), Some(200), &[4242, 100, 7]),
            vec![7, 200, 4242]
        );
        assert_eq!(
            pids_to_kill(100, None, Some(100), &[100]),
            Vec::<u32>::new()
        );
    }

    #[test]
    fn strips_verbatim_disk_prefix() {
        assert_eq!(
            strip_win32_verbatim_prefix(r"\\?\D:\Agent Room\node\node.exe").as_deref(),
            Some(r"D:\Agent Room\node\node.exe")
        );
        assert_eq!(
            strip_win32_verbatim_prefix(r"\\?\D:\Agent Room\daemon\agent-room-daemon.mjs")
                .as_deref(),
            Some(r"D:\Agent Room\daemon\agent-room-daemon.mjs")
        );
        assert_eq!(
            strip_win32_verbatim_prefix(r"\\?\D:\Agent Room\daemon").as_deref(),
            Some(r"D:\Agent Room\daemon")
        );
    }

    #[test]
    fn maps_verbatim_unc_to_unc() {
        assert_eq!(
            strip_win32_verbatim_prefix(r"\\?\UNC\server\share\node.exe").as_deref(),
            Some(r"\\server\share\node.exe")
        );
    }

    #[test]
    fn leaves_ordinary_paths_alone() {
        assert_eq!(
            strip_win32_verbatim_prefix(r"D:\Agent Room\node\node.exe"),
            None
        );
        assert_eq!(
            strip_win32_verbatim_prefix(r"\\server\share\node.exe"),
            None
        );
        assert_eq!(strip_win32_verbatim_prefix(r"\\?\"), None);
        assert_eq!(strip_win32_verbatim_prefix(r"\\?\UNC\"), None);
    }

    #[test]
    fn rejects_relative_dot_agent_room_and_keeps_spaced_install_logs() {
        assert!(is_unsafe_log_dir_text(r".\.agent-room"));
        assert!(is_unsafe_log_dir_text(r".\.agent-room\logs"));
        assert!(is_unsafe_log_dir_text("./.agent-room"));
        assert!(!is_unsafe_log_dir_text(
            r"C:\Users\a\AppData\Local\Agent Room\logs"
        ));
        assert!(!is_unsafe_log_dir_text(r"\\server\share\Agent Room\logs"));

        let root = std::env::temp_dir().join(format!("agent-room-logs-{}", std::process::id()));
        let spaced = root.join("Agent Room").join("logs");
        let chosen = choose_log_dir(&[Some(PathBuf::from(r".\.agent-room")), Some(spaced.clone())]);
        assert_eq!(chosen, spaced);
        assert!(spaced.is_dir());
        let shown = chosen.to_string_lossy();
        assert!(!shown.contains(r".\.agent-room"));
        assert!(shown.contains("Agent Room"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn for_node_argv_strips_only_on_windows() {
        let verbatim = PathBuf::from(r"\\?\D:\Agent Room\daemon");
        let plain = PathBuf::from(r"D:\Agent Room\daemon");
        #[cfg(windows)]
        {
            assert_eq!(for_node_argv(verbatim), plain);
            assert_eq!(for_node_argv(plain.clone()), plain);
        }
        #[cfg(not(windows))]
        {
            assert_eq!(for_node_argv(verbatim.clone()), verbatim);
            assert_eq!(for_node_argv(plain.clone()), plain);
        }
    }
    #[test]
    fn terminal_seat_map_round_trip() {
        let label = format!("{}-{}", terminal_window_label("st_06eb2797"), "round");
        remember_terminal_seat(&label, "st_06eb2797");
        assert_eq!(take_terminal_seat(&label).as_deref(), Some("st_06eb2797"));
        assert_eq!(take_terminal_seat(&label), None);
    }

    #[test]
    fn terminal_window_label_sanitizes() {
        assert_eq!(terminal_window_label("seat-1"), "terminal-seat-1");
        assert_eq!(terminal_window_label("a/b c"), "terminal-a_b_c");
        assert_eq!(terminal_window_label("  "), "terminal-seat");
        assert!(terminal_window_label(&"x".repeat(200)).len() <= "terminal-".len() + 96);
    }

    #[test]
    fn clamps_terminal_geometry() {
        assert_eq!(clamp_terminal_size(100.0, 100.0), (480.0, 320.0));
        assert_eq!(clamp_terminal_size(800.0, 500.0), (800.0, 500.0));
        assert_eq!(clamp_terminal_size(9000.0, 9000.0), (3840.0, 2160.0));
        assert_eq!(clamp_terminal_size(f64::NAN, 500.0), (960.0, 500.0));
        assert_eq!(clamp_terminal_size(700.0, f64::INFINITY), (700.0, 640.0));
        assert_eq!(
            clamp_terminal_position(Some(12.0), Some(-40.0)),
            Some((12.0, -40.0))
        );
        assert_eq!(
            clamp_terminal_position(Some(-9000.0), Some(20000.0)),
            Some((-8000.0, 16000.0))
        );
        assert_eq!(clamp_terminal_position(Some(1.0), None), None);
        assert_eq!(clamp_terminal_position(Some(f64::NAN), Some(1.0)), None);
    }

    #[test]
    fn managed_terminal_url_matches_settings_popout() {
        let url = open_managed_terminal_url(Some("http://127.0.0.1:17421/?t=abc"), "s1").unwrap();
        assert_eq!(url, "http://127.0.0.1:17421/?t=abc&terminal=s1&popout=1");
        let local = open_managed_terminal_url(
            Some("http://localhost:17421/?t=tok&extra=1"),
            " st_06eb2797 ",
        )
        .unwrap();
        assert_eq!(
            local,
            "http://localhost:17421/?t=tok&terminal=st_06eb2797&popout=1"
        );
        let encoded = managed_terminal_popout_url("http://127.0.0.1:9/?t=a%26b", "seat-1").unwrap();
        assert_eq!(
            encoded,
            "http://127.0.0.1:9/?t=a%26b&terminal=seat-1&popout=1"
        );
    }

    #[test]
    fn managed_terminal_url_rejects_missing_daemon_and_bad_seat() {
        let missing = open_managed_terminal_url(None, "st_1").unwrap_err();
        assert!(missing.contains("尚未就绪"));
        assert!(open_managed_terminal_url(Some("  "), "st_1").is_err());
        assert!(
            open_managed_terminal_url(Some("http://127.0.0.1:1/"), "st_1")
                .unwrap_err()
                .contains("令牌")
        );
        assert!(managed_terminal_popout_url("https://ai-room.example/?t=abc", "st_1").is_err());
        assert!(managed_terminal_popout_url("http://127.0.0.1:1/?t=abc", " ").is_err());
        assert!(managed_terminal_popout_url("http://127.0.0.1:1/?t=abc", "../x").is_err());
        assert!(managed_terminal_popout_url("http://127.0.0.1:1/?x=1", "st_1").is_err());
    }

    #[test]
    fn control_json_builds_daemon_control_url() {
        let url = control_url_from_json(r#"{"port":17421,"token":"abc"}"#).unwrap();
        assert_eq!(url, "http://127.0.0.1:17421/?t=abc");
        let pretty =
            control_url_from_json("{\n  \"port\": 17421,\n  \"token\": \"deadbeef\"\n}\n").unwrap();
        assert_eq!(pretty, "http://127.0.0.1:17421/?t=deadbeef");
        let pop = open_managed_terminal_url(Some(&url), "st_1").unwrap();
        assert_eq!(pop, "http://127.0.0.1:17421/?t=abc&terminal=st_1&popout=1");
    }

    #[test]
    fn control_json_rejects_unusable_payloads() {
        assert!(control_url_from_json("").is_none());
        assert!(control_url_from_json("{}").is_none());
        assert!(control_url_from_json("not-json").is_none());
        assert!(control_url_from_json(r#"{"port":0,"token":"abc"}"#).is_none());
        assert!(control_url_from_json(r#"{"port":65536,"token":"abc"}"#).is_none());
        assert!(control_url_from_json(r#"{"port":17421,"token":""}"#).is_none());
        assert!(control_url_from_json(r#"{"port":17421}"#).is_none());
        assert!(control_url_from_json(r#"{"port":"17421","token":"abc"}"#).is_none());
        assert!(control_url_from_json(r#"{"port":17421,"token":"has space"}"#).is_none());
    }

    #[test]
    fn control_json_round_trips_encoded_token() {
        let url = control_url_from_json(r#"{"port":9,"token":"a/b"}"#).unwrap();
        assert_eq!(url, "http://127.0.0.1:9/?t=a%2Fb");
        let (origin, token) = control_origin_and_token(&url).unwrap();
        assert_eq!(origin, "http://127.0.0.1:9");
        assert_eq!(token, "a/b");
    }

    #[test]
    fn persisted_control_url_reads_state_dir() {
        let dir = std::env::temp_dir().join(format!(
            "agent-room-control-{}-{}",
            std::process::id(),
            "json"
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("control.json"),
            b"{\"port\":17421,\"token\":\"abc\"}\n",
        )
        .unwrap();
        assert_eq!(
            persisted_control_url(&dir).as_deref(),
            Some("http://127.0.0.1:17421/?t=abc")
        );
        assert!(persisted_control_url(&dir.join("missing")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn http_status_ok_only_200() {
        assert!(http_status_is_ok(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json"
        ));
        assert!(http_status_is_ok("HTTP/1.0 200 OK"));
        assert!(!http_status_is_ok("HTTP/1.1 401 Unauthorized"));
        assert!(!http_status_is_ok("HTTP/1.1 500"));
        assert!(!http_status_is_ok("not http"));
    }

    fn serve_status(status: &str) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let status = status.to_string();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf);
            let body =
                format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
            let _ = sock.write_all(body.as_bytes());
        });
        port
    }

    #[test]
    fn probe_accepts_live_terminals_and_rejects_dead_or_unauthorized() {
        let port = serve_status("200 OK");
        assert!(probe_control_alive(&format!(
            "http://127.0.0.1:{port}/?t=abc"
        )));
        let denied = serve_status("401 Unauthorized");
        assert!(!probe_control_alive(&format!(
            "http://127.0.0.1:{denied}/?t=abc"
        )));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!probe_control_alive(&format!(
            "http://127.0.0.1:{closed}/?t=abc"
        )));
        assert!(!probe_control_alive("http://127.0.0.1:1/"));
    }
}
