/// Legacy command-line flags, kept so existing launchers and window-manager
/// bindings (e.g. `parrot --toggle-transcription`) keep working.
#[derive(Debug, Clone, Default)]
pub struct CliArgs {
    /// Start with the main window hidden
    pub start_hidden: bool,
    /// Disable the system tray icon
    pub no_tray: bool,
    /// Trigger text-to-speech (sent to running instance)
    pub toggle_transcription: bool,
    /// Cancel the current operation (sent to running instance)
    pub cancel: bool,
    /// Enable debug mode with verbose logging
    pub debug: bool,
}

impl CliArgs {
    pub fn from_env() -> Self {
        Self::from_args(std::env::args().skip(1))
    }

    pub fn from_args<I, S>(args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut cli = Self::default();
        for arg in args {
            match arg.as_ref() {
                "--start-hidden" => cli.start_hidden = true,
                "--no-tray" => cli.no_tray = true,
                "--toggle-transcription" => cli.toggle_transcription = true,
                "--cancel" => cli.cancel = true,
                "--debug" => cli.debug = true,
                _ => {}
            }
        }
        cli
    }
}

#[cfg(test)]
mod tests {
    use super::CliArgs;

    #[test]
    fn parses_legacy_flags_and_ignores_unknown_args() {
        let cli = CliArgs::from_args([
            "--toggle-transcription",
            "--start-hidden",
            "--unknown",
            "--no-tray",
        ]);
        assert!(cli.toggle_transcription);
        assert!(cli.start_hidden);
        assert!(cli.no_tray);
        assert!(!cli.cancel);
        assert!(!cli.debug);
    }
}
