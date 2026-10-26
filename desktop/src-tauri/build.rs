fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(&["open_terminal_window", "close_terminal_window"]),
        ),
    )
    .expect("failed to run tauri-build");
}
