use crate::managers::tts::TTSManager;
use crate::utils::show_processing_overlay;
use log::{debug, info};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

const SHORTCUT_SETTLE_DELAY_MS: u64 = 40;

// Shortcut Action Trait
pub trait ShortcutAction: Send + Sync {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
}

// Play/Pause Action
struct PlayPauseAction;

impl ShortcutAction for PlayPauseAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        if let Some(speech) = app.try_state::<Arc<TTSManager>>() {
            if let Ok(is_paused) = speech.toggle_pause() {
                if let Some(overlay_window) = app.get_webview_window("speaking_overlay") {
                    let _ = overlay_window.emit("tts-pause-state", is_paused);
                }
            }
        }
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Nothing to do on key release
    }
}

// Test Action
struct TestAction;

impl ShortcutAction for TestAction {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        info!(
            "Shortcut ID '{}': Started - {} (App: {})",
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        info!(
            "Shortcut ID '{}': Stopped - {} (App: {})",
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }
}

// Speak Action — reads selected text via macOS Accessibility API and speaks it with Kokoro TTS.
struct SpeakAction;

/// Read the currently selected text using the macOS Accessibility API.
/// Does not touch the clipboard. Returns `None` when nothing is selected or
/// accessibility is unavailable.
#[cfg(target_os = "macos")]
fn get_selected_text() -> Option<String> {
    use std::ffi::{c_char, c_void, CStr};
    use std::ptr;

    type Ptr = *mut c_void;
    const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> Ptr;
        fn AXUIElementCopyAttributeValue(element: Ptr, attribute: Ptr, value: *mut Ptr) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: Ptr);
        fn CFStringCreateWithBytes(
            alloc: *const c_void,
            bytes: *const u8,
            num_bytes: i64,
            encoding: u32,
            is_external: bool,
        ) -> Ptr;
        fn CFStringGetLength(s: Ptr) -> i64;
        fn CFStringGetCString(s: Ptr, buf: *mut c_char, buf_size: i64, encoding: u32) -> bool;
    }

    unsafe fn cf_str(bytes: &[u8]) -> Ptr {
        CFStringCreateWithBytes(ptr::null(), bytes.as_ptr(), bytes.len() as i64, UTF8, false)
    }

    unsafe fn cf_to_string(ptr: Ptr) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        let len = CFStringGetLength(ptr);
        let buf_size = len * 4 + 1; // worst-case UTF-8 bytes + NUL
        let mut buf = vec![0u8; buf_size as usize];
        let ok = CFStringGetCString(ptr, buf.as_mut_ptr() as *mut c_char, buf_size, UTF8);
        CFRelease(ptr);
        if !ok {
            return None;
        }
        CStr::from_ptr(buf.as_ptr() as *const c_char)
            .to_str()
            .ok()
            .map(str::to_owned)
    }

    unsafe {
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            return None;
        }

        let focused_attr = cf_str(b"AXFocusedUIElement");
        let mut focused: Ptr = ptr::null_mut();
        let err = AXUIElementCopyAttributeValue(system, focused_attr, &mut focused);
        CFRelease(focused_attr);
        CFRelease(system);
        if err != 0 || focused.is_null() {
            return None;
        }

        let text_attr = cf_str(b"AXSelectedText");
        let mut value: Ptr = ptr::null_mut();
        let err = AXUIElementCopyAttributeValue(focused, text_attr, &mut value);
        CFRelease(text_attr);
        CFRelease(focused);
        if err != 0 || value.is_null() {
            return None;
        }

        cf_to_string(value).filter(|s| !s.trim().is_empty())
    }
}

#[cfg(target_os = "macos")]
fn get_selected_text_with_fallback(app: &AppHandle) -> Option<String> {
    // Retry AX selection reads because some apps only expose selection once the
    // shortcut state has settled.
    for delay_ms in [0_u64, 40, 90] {
        if delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
        if let Some(text) = get_selected_text() {
            return Some(text);
        }
    }

    // Fallback: trigger Cmd+C and read clipboard while restoring original content.
    let clipboard = app.clipboard();
    let previous_clipboard = clipboard.read_text().ok();
    let restore_clipboard = |value: Option<String>| {
        let restore_value = value.unwrap_or_default();
        let _ = clipboard.write_text(restore_value);
    };

    // Use a sentinel so we can reliably tell whether copy actually produced text.
    let sentinel = format!(
        "__PARROT_SELECTION_PROBE_{}__",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis())
            .unwrap_or_default()
    );
    let _ = clipboard.write_text(&sentinel);

    {
        use crate::input::{send_copy_ctrl_c, EnigoState};
        let enigo_state = app.try_state::<EnigoState>()?;
        let mut enigo = enigo_state.0.lock().ok()?;
        if send_copy_ctrl_c(&mut enigo).is_err() {
            restore_clipboard(previous_clipboard);
            return None;
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(120));
    let copied_text = clipboard.read_text().ok();

    restore_clipboard(previous_clipboard);

    let copied = copied_text?.trim().to_string();
    if copied.is_empty() || copied == sentinel {
        None
    } else {
        Some(copied)
    }
}

/// Returns the copied text, or `None` if the copy left the probe sentinel (or nothing) behind.
#[cfg(not(target_os = "macos"))]
fn copied_text_from_probe(copied_text: Option<String>, sentinel: &str) -> Option<String> {
    let copied = copied_text?.trim().to_string();
    if copied.is_empty() || copied == sentinel {
        None
    } else {
        Some(copied)
    }
}

/// On Wayland, enigo's synthetic Ctrl+C only reaches XWayland windows, so native
/// Wayland apps never copy. Fall back to the PRIMARY selection, which Wayland apps
/// update whenever the user highlights text.
#[cfg(not(target_os = "macos"))]
fn prefer_copied_then_primary(
    copied: Option<String>,
    read_primary: impl FnOnce() -> Option<String>,
) -> Option<String> {
    copied.or_else(|| {
        read_primary()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
    })
}

/// PRIMARY keeps its last value after text is deselected, so it is only used where
/// Ctrl+C cannot work. On X11 a failed Ctrl+C really means nothing is selected.
#[cfg(target_os = "linux")]
fn is_wayland_session(wayland_display: Option<&str>, session_type: Option<&str>) -> bool {
    wayland_display.is_some_and(|display| !display.is_empty())
        || session_type.is_some_and(|kind| kind.eq_ignore_ascii_case("wayland"))
}

#[cfg(target_os = "linux")]
fn read_primary_selection() -> Option<String> {
    use arboard::{Clipboard, GetExtLinux, LinuxClipboardKind};

    let wayland_display = std::env::var("WAYLAND_DISPLAY").ok();
    let session_type = std::env::var("XDG_SESSION_TYPE").ok();
    if !is_wayland_session(wayland_display.as_deref(), session_type.as_deref()) {
        return None;
    }

    let mut clipboard = Clipboard::new().ok()?;
    clipboard
        .get()
        .clipboard(LinuxClipboardKind::Primary)
        .text()
        .ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_primary_selection() -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
fn get_selected_text_with_fallback(app: &AppHandle) -> Option<String> {
    let copied = copy_selection_with_ctrl_c(app);
    if copied.is_none() {
        debug!("Ctrl+C produced no selection; trying the PRIMARY selection");
    }
    prefer_copied_then_primary(copied, read_primary_selection)
}

#[cfg(not(target_os = "macos"))]
fn copy_selection_with_ctrl_c(app: &AppHandle) -> Option<String> {
    let clipboard = app.clipboard();
    let previous_clipboard = clipboard.read_text().ok();
    let restore_clipboard = |value: Option<String>| {
        let restore_value = value.unwrap_or_default();
        let _ = clipboard.write_text(restore_value);
    };

    // Use a sentinel so we can reliably tell whether copy actually produced text.
    let sentinel = format!(
        "__PARROT_SELECTION_PROBE_{}__",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis())
            .unwrap_or_default()
    );
    let _ = clipboard.write_text(&sentinel);

    {
        use crate::input::{send_copy_ctrl_c, EnigoState};
        let enigo_state = app.try_state::<EnigoState>()?;
        let mut enigo = enigo_state.0.lock().ok()?;
        if send_copy_ctrl_c(&mut enigo).is_err() {
            restore_clipboard(previous_clipboard);
            return None;
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(120));
    let copied_text = clipboard.read_text().ok();

    restore_clipboard(previous_clipboard);

    copied_text_from_probe(copied_text, &sentinel)
}

impl ShortcutAction for SpeakAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        let speech = Arc::clone(&app.state::<Arc<TTSManager>>());
        let Some(request_id) = speech.begin_request_or_toggle_stop() else {
            return;
        };

        speech.initiate_model_load();
        let app_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(SHORTCUT_SETTLE_DELAY_MS));

            match get_selected_text_with_fallback(&app_handle) {
                Some(text) => {
                    if !speech.is_request_active(request_id) {
                        return;
                    }
                    // Show overlay only after grabbing text — showing it before
                    // the copy causes WM_ACTIVATE to steal focus from the source
                    // app on Windows, so the injected Ctrl+C lands in the overlay
                    // instead of the text the user had selected.
                    show_processing_overlay(&app_handle);
                    debug!("Speaking {} chars via TTS", text.len());
                    speech.speak(text, request_id);
                }
                None => {
                    if !speech.stop_if_request_active(request_id) {
                        return;
                    }
                    debug!("No selected text found for TTS hotkey");
                    let _ = app_handle.emit("tts-no-selection", ());
                }
            }
        });
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Nothing to do on key release — playback continues until interrupted by another press or cancel.
    }
}

pub static ACTION_MAP: Lazy<HashMap<String, Arc<dyn ShortcutAction>>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "speak".to_string(),
        Arc::new(SpeakAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "play_pause".to_string(),
        Arc::new(PlayPauseAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "test".to_string(),
        Arc::new(TestAction) as Arc<dyn ShortcutAction>,
    );
    map
});

#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    use super::{copied_text_from_probe, prefer_copied_then_primary};

    #[test]
    fn probe_rejects_unchanged_sentinel_and_blank_text() {
        assert_eq!(
            copied_text_from_probe(Some("__probe__".into()), "__probe__"),
            None
        );
        assert_eq!(
            copied_text_from_probe(Some("  \n ".into()), "__probe__"),
            None
        );
        assert_eq!(copied_text_from_probe(None, "__probe__"), None);
        assert_eq!(
            copied_text_from_probe(Some("  hello world \n".into()), "__probe__"),
            Some("hello world".into())
        );
    }

    #[test]
    fn copied_text_wins_without_reading_primary() {
        let selection = prefer_copied_then_primary(Some("copied".into()), || {
            panic!("PRIMARY must not be read when Ctrl+C worked")
        });
        assert_eq!(selection, Some("copied".into()));
    }

    #[test]
    fn falls_back_to_primary_selection_when_copy_fails() {
        let selection = prefer_copied_then_primary(None, || Some("  highlighted text \n".into()));
        assert_eq!(selection, Some("highlighted text".into()));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn primary_fallback_is_wayland_only() {
        use super::is_wayland_session;
        assert!(is_wayland_session(Some("wayland-1"), None));
        assert!(is_wayland_session(None, Some("wayland")));
        assert!(!is_wayland_session(None, Some("x11")));
        assert!(!is_wayland_session(Some(""), None));
        assert!(!is_wayland_session(None, None));
    }

    #[test]
    fn empty_primary_selection_is_no_selection() {
        assert_eq!(
            prefer_copied_then_primary(None, || Some("   ".into())),
            None
        );
        assert_eq!(prefer_copied_then_primary(None, || None), None);
    }
}
