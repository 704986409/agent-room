// Agent Room Desktop shell (design §2): window + tray + local settings page.
// The shell owns no business logic. It starts/stops the Node daemon and shows
// two webviews: the remote web app (no IPC) and the daemon's 127.0.0.1
// settings page (token-protected, no IPC either).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

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
        let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| {
            PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()))
                .join("AppData")
                .join("Roaming")
        });
        return base.join("agent-room");
    }
    #[cfg(not(windows))]
    {
        let base = std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| {
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
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|p| p.join("daemon").join("agent-room-daemon.mjs"))),
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

/// `%USERPROFILE%\.agent-room` on Windows, `~/.agent-room` elsewhere.
fn daemon_log_dir() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()))
            .join(".agent-room")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".agent-room")
    }
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

fn persistent_webview_data_directory(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        app.path()
            .app_local_data_dir()
            .map(Some)
            .map_err(|e| format!("无法确定 WebView 持久化目录: {e}"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        // WKWebView uses its persistent default website data store on macOS;
        // Tauri's data_directory setting is unavailable there.
        let _ = app;
        Ok(None)
    }
}

fn main_window_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let settings = MenuItem::with_id(app, "window-settings", "本机设置", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let app_menu = Submenu::with_items(app, "Agent Room", true, &[&settings])
        .map_err(|e| e.to_string())?;
    Menu::with_items(app, &[&app_menu]).map_err(|e| e.to_string())
}

fn open_settings_window(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = url
        .parse()
        .map_err(|e| format!("本机设置地址无效: {e}\n{url}"))?;
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.close();
    }
    let mut builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::External(parsed));
    if let Some(data_dir) = persistent_webview_data_directory(app)? {
        builder = builder.data_directory(data_dir);
    }
    builder
        .title("Agent Room · 本机设置")
        .inner_size(900.0, 720.0)
        .build()
        .map_err(|e| format!("无法打开本机设置窗口: {e}"))?;
    Ok(())
}

impl Daemon {
    fn running(&self) -> bool {
        let mut g = self.0.lock().unwrap();
        match g.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }

    fn start(&self, app: &AppHandle) -> Result<(), String> {
        if self.running() {
            return Ok(());
        }
        let script = daemon_script(app).ok_or_else(|| {
            "找不到本机后台脚本 daemon/agent-room-daemon.mjs（安装包不完整？）".to_string()
        })?;
        let node = find_node(app)?;
        let cwd = script
            .parent()
            .filter(|dir| dir.is_dir())
            .map(|dir| dir.to_path_buf());
        let mut log = open_daemon_log()?;
        let _ = writeln!(
            log,
            "----- {} daemon start -----\nnode: {}\nscript: {}\ncwd: {}",
            log_stamp(),
            node.display(),
            script.display(),
            cwd.as_ref()
                .map(|dir| dir.display().to_string())
                .unwrap_or_else(|| "(unchanged)".into())
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
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(stderr));
        if let Some(dir) = &cwd {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

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

    fn stop(&self) {
        let mut g = self.0.lock().unwrap();
        if let Some(mut c) = g.child.take() {
            #[cfg(unix)]
            {
                let _ = Command::new("kill")
                    .arg("-TERM")
                    .arg(c.id().to_string())
                    .status();
                let deadline = Instant::now() + Duration::from_secs(3);
                while Instant::now() < deadline {
                    if let Ok(Some(_)) = c.try_wait() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            let _ = c.kill();
            let _ = c.wait();
        }
        g.control_url = None;
    }

    fn wait_control_url(&self, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(u) = self.0.lock().unwrap().control_url.clone() {
                return Some(u);
            }
            if Instant::now() > deadline || !self.running() {
                return None;
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
    match persistent_webview_data_directory(app) {
        Ok(Some(data_dir)) => builder = builder.data_directory(data_dir),
        Ok(None) => {}
        Err(e) => {
            alert("Agent Room", &e);
            return;
        }
    }
    if let Err(e) = builder
        .title("Agent Room")
        .inner_size(1200.0, 800.0)
        .menu(menu)
        .build()
    {
        alert("Agent Room", &format!("无法打开主窗口: {e}"));
    }
}

fn spawn_show_settings(app: &AppHandle, daemon: &Daemon) {
    let (app, daemon) = (app.clone(), daemon.clone());
    std::thread::spawn(move || show_settings(app, daemon));
}

fn report_autostart_readiness(daemon: Daemon) {
    if daemon.wait_control_url(Duration::from_secs(8)).is_some() {
        return;
    }
    let detail = if daemon.running() {
        "本机后台进程已启动，但 8 秒内没有报告控制页地址。请确认安装包中的 daemon 文件完整，然后从主窗口菜单「本机设置」重试。"
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
    let Some(url) = daemon.wait_control_url(Duration::from_secs(8)) else {
        let hint = if daemon.running() {
            "本机后台已启动，但 8 秒内未报到控制页地址（control: URL）。\n请查看安装目录下 daemon 是否完整，或重新打开主窗口菜单「本机设置」重试。"
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

fn main() {
    let daemon = Daemon::default();
    let daemon_for_exit = daemon.clone();
    tauri::Builder::default()
        .manage(daemon.clone())
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
                    "quit" => {
                        d.stop();
                        app.exit(0);
                    }
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
            // Closing the main window hides it; the tray keeps the app (and daemon) alive.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
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
