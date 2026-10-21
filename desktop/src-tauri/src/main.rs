// Agent Room Desktop shell (design §2): window + tray + local settings page.
// The shell owns no business logic. It starts/stops the Node daemon and shows
// two webviews: the remote web app (no IPC) and the daemon's 127.0.0.1
// settings page (token-protected, no IPC either).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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
        if !v.is_empty() { return v; }
    }
    if let Ok(raw) = std::fs::read_to_string(config_dir().join("desktop.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(s) = v.get("serverUrl").and_then(|s| s.as_str()) { return s.to_string(); }
        }
    }
    "https://ai-room.pupgo.top".to_string()
}

fn daemon_script(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AGENT_ROOM_DAEMON_SCRIPT") { return Some(PathBuf::from(p)); }
    let candidates = [
        app.path().resource_dir().ok().map(|d| d.join("daemon").join("agent-room-daemon.mjs")),
        std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("daemon").join("agent-room-daemon.mjs"))),
    ];
    candidates.into_iter().flatten().find(|p| p.exists())
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
        if self.running() { return Ok(()); }
        let script = daemon_script(app).ok_or("daemon script not found (set AGENT_ROOM_DAEMON_SCRIPT)")?;
        let node = std::env::var("AGENT_ROOM_NODE").unwrap_or_else(|_| "node".into());
        let mut child = Command::new(node)
            .arg(script)
            .args(["serve", "--server", &server_url()])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to start daemon (is Node.js >= 20 installed?): {e}"))?;
        let stdout = child.stdout.take().unwrap();
        {
            let mut g = self.0.lock().unwrap();
            g.child = Some(child);
            g.control_url = None;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(url) = line.strip_prefix("control: ") {
                    me.0.lock().unwrap().control_url = Some(url.trim().to_string());
                } else {
                    println!("[daemon] {line}");
                }
            }
        });
        Ok(())
    }

    fn stop(&self) {
        let mut g = self.0.lock().unwrap();
        if let Some(mut c) = g.child.take() {
            // SIGTERM for a clean shutdown; agent children are detached and survive.
            let _ = Command::new("kill").arg("-TERM").arg(c.id().to_string()).status();
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if let Ok(Some(_)) = c.try_wait() { break; }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = c.kill();
            let _ = c.wait();
        }
        g.control_url = None;
    }

    fn wait_control_url(&self, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(u) = self.0.lock().unwrap().control_url.clone() { return Some(u); }
            if Instant::now() > deadline || !self.running() { return None; }
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
    let url = server_url().parse().expect("invalid server url");
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Agent Room")
        .inner_size(1200.0, 800.0)
        .build();
}

fn show_settings(app: &AppHandle, daemon: &Daemon) {
    if let Err(e) = daemon.start(app) { eprintln!("{e}"); }
    let Some(url) = daemon.wait_control_url(Duration::from_secs(8)) else {
        eprintln!("daemon did not report a control URL");
        return;
    };
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.close();
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::External(url.parse().unwrap()))
        .title("Agent Room · 本机设置")
        .inner_size(900.0, 720.0)
        .build();
}

fn main() {
    let daemon = Daemon::default();
    let daemon_for_exit = daemon.clone();
    tauri::Builder::default()
        .manage(daemon.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            if std::env::var("AGENT_ROOM_NO_DAEMON").is_err() {
                if let Err(e) = daemon.start(&handle) { eprintln!("{e}"); }
            }
            let open = MenuItem::with_id(app, "open", "打开 Agent Room", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "本机设置", true, None::<&str>)?;
            let start = MenuItem::with_id(app, "start", "启动后台程序", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "停止后台程序", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &settings, &sep, &start, &stop, &sep, &quit])?;
            let d = daemon.clone();
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("Agent Room")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "settings" => { let (a, d) = (app.clone(), d.clone()); std::thread::spawn(move || show_settings(&a, &d)); }
                    "start" => { if let Err(e) = d.start(app) { eprintln!("{e}"); } }
                    "stop" => d.stop(),
                    "quit" => { d.stop(); app.exit(0); }
                    _ => {}
                })
                .build(app)?;
            show_main(&handle);
            if std::env::var("AGENT_ROOM_OPEN_SETTINGS").is_ok() {
                let (a, d) = (handle.clone(), daemon.clone());
                std::thread::spawn(move || show_settings(&a, &d));
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
            if let tauri::RunEvent::Exit = event { daemon_for_exit.stop(); }
        });
}
