import type { Page } from "@playwright/test";

export const defaultSettings = {
  app_language: "en",
  audio_feedback: false,
  audio_feedback_volume: 1.0,
  autostart_enabled: false,
  bindings: {
    play_pause: {
      current_binding: "disabled",
      default_binding: "alt+p",
      description: "Pause or resume speech playback.",
      id: "play_pause",
      name: "Play/Pause Shortcut",
    },
    speak: {
      current_binding: "ctrl+space",
      default_binding: "ctrl+space",
      description: "Read the selected text aloud. Press again to stop.",
      id: "speak",
      name: "Read Aloud Shortcut",
    },
  },
  debug_mode: false,
  history_limit: 3,
  history_retention_period: "preserve_limit",
  keyboard_implementation: "tauri",
  log_level: "debug",
  model_unload_timeout: "never",
  overlay_position: "none",
  selected_kokoro_voice: null,
  selected_language: "auto",
  selected_model: "kokoro",
  selected_output_device: null,
  show_close_button: true,
  show_tray_icon: true,
  sound_theme: "marimba",
  start_hidden: false,
  tts_shorten_first_chunk: true,
  tts_speed: 1.0,
  update_checks_enabled: true,
};

export type InvokeCall = { cmd: string; args: unknown };

/**
 * Installs a fake Tauri IPC layer so the React UI can run in a plain browser.
 * Every invoke is recorded on `window.__invokeCalls` for assertions.
 */
export async function mockTauri(
  page: Page,
  overrides: Record<string, unknown> = {},
) {
  await page.addInitScript(
    ({ settings, overrides }) => {
      const calls: { cmd: string; args: unknown }[] = [];
      const callbacks = new Map<number, unknown>();
      let nextId = 1;
      const responses: Record<string, unknown> = {
        get_app_settings: settings,
        get_default_settings: settings,
        has_any_models_available: true,
        "plugin:app|version": "0.0.0-test",
        "plugin:app|name": "Parrot",
        ...overrides,
      };
      const listLike = /(devices|models|entries|voices|languages|list)$/;

      (window as any).__invokeCalls = calls;
      (window as any).__TAURI_OS_PLUGIN_INTERNALS__ = {
        platform: "linux",
        os_type: "linux",
        family: "unix",
        arch: "x86_64",
        version: "6.0.0",
        exe_extension: "",
        eol: "\n",
      };
      (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: () => {},
      };
      (window as any).__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
        transformCallback: (cb: unknown) => {
          const id = nextId++;
          callbacks.set(id, cb);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        convertFileSrc: (path: string) => path,
        invoke: async (cmd: string, args: unknown) => {
          calls.push({ cmd, args });
          if (cmd in responses) return responses[cmd];
          if (cmd === "plugin:event|listen") return nextId++;
          const name = cmd.split("|").pop() ?? cmd;
          if (name.startsWith("get_") && listLike.test(name)) return [];
          return null;
        },
      };
    },
    { settings: defaultSettings, overrides },
  );
}

export async function invokeCalls(page: Page): Promise<InvokeCall[]> {
  return page.evaluate(() => (window as any).__invokeCalls);
}
