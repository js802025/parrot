//! Piper TTS: single-file VITS ONNX voices (e.g. `rhasspy/piper-voices`),
//! phonemized with espeak-ng like Kokoro.
//!
//! A model directory holds `<voice>.onnx` plus its `<voice>.onnx.json` config.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ndarray::{arr1, Array2};
use ort::inputs;
use ort::session::Session;
use ort::value::TensorRef;
use serde::Deserialize;

use super::kokoro::model::init_session;
use super::kokoro::phonemizer::{phonemize, EspeakConfig};
use super::kokoro::KokoroError;
use crate::SynthesisResult;

const PAD: &str = "_";
const BOS: &str = "^";
const EOS: &str = "$";

#[derive(Debug, Deserialize)]
struct PiperConfig {
    audio: AudioConfig,
    espeak: EspeakVoice,
    #[serde(default)]
    inference: InferenceConfig,
    phoneme_id_map: HashMap<String, Vec<i64>>,
    #[serde(default)]
    num_speakers: u32,
    #[serde(default)]
    speaker_id_map: HashMap<String, i64>,
}

#[derive(Debug, Deserialize)]
struct AudioConfig {
    sample_rate: u32,
}

#[derive(Debug, Deserialize)]
struct EspeakVoice {
    voice: String,
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct InferenceConfig {
    noise_scale: f32,
    length_scale: f32,
    noise_w: f32,
}

impl Default for InferenceConfig {
    fn default() -> Self {
        Self {
            noise_scale: 0.667,
            length_scale: 1.0,
            noise_w: 0.8,
        }
    }
}

struct PiperModel {
    session: Session,
    config: PiperConfig,
    vocab: HashMap<char, i64>,
    pad: i64,
    bos: i64,
    eos: i64,
}

/// Piper speech synthesis engine.
#[derive(Default)]
pub struct PiperEngine {
    espeak: EspeakConfig,
    model: Option<PiperModel>,
}

impl PiperEngine {
    pub fn with_espeak(bin_path: Option<PathBuf>, data_path: Option<PathBuf>) -> Self {
        Self {
            espeak: EspeakConfig {
                bin_path,
                data_path,
            },
            model: None,
        }
    }

    pub fn load_model(
        &mut self,
        model_dir: &Path,
        num_threads: Option<usize>,
    ) -> Result<(), KokoroError> {
        let (onnx_path, config_path) = find_voice_files(model_dir)?;
        let config = parse_config(&std::fs::read_to_string(&config_path)?)?;
        let id = |symbol: &str| {
            config
                .phoneme_id_map
                .get(symbol)
                .and_then(|ids| ids.first().copied())
                .ok_or_else(|| KokoroError::Config(format!("phoneme_id_map is missing '{symbol}'")))
        };
        let (pad, bos, eos) = (id(PAD)?, id(BOS)?, id(EOS)?);
        let vocab = single_char_vocab(&config.phoneme_id_map);
        log::info!("Loading Piper voice from {}", onnx_path.display());
        let session = init_session(&onnx_path, num_threads, None)?;
        self.model = Some(PiperModel {
            session,
            config,
            vocab,
            pad,
            bos,
            eos,
        });
        Ok(())
    }

    pub fn unload_model(&mut self) {
        self.model = None;
    }

    /// Speaker names for multi-speaker voices; empty for single-speaker ones.
    pub fn list_speakers(&self) -> Vec<String> {
        let Some(model) = &self.model else {
            return Vec::new();
        };
        let mut speakers: Vec<(&String, &i64)> = model.config.speaker_id_map.iter().collect();
        speakers.sort_by_key(|(_, id)| **id);
        speakers.into_iter().map(|(name, _)| name.clone()).collect()
    }

    /// Synthesize `text`. `speed` > 1.0 speaks faster. `speaker` selects a
    /// speaker on multi-speaker voices (defaults to the first).
    pub fn synthesize(
        &mut self,
        text: &str,
        speed: f32,
        speaker: Option<&str>,
    ) -> Result<SynthesisResult, KokoroError> {
        let model = self.model.as_mut().ok_or(KokoroError::ModelNotLoaded)?;
        let sample_rate = model.config.audio.sample_rate;
        let phonemes = phonemize(text, &model.config.espeak.voice, &model.vocab, &self.espeak)?;
        if phonemes.is_empty() {
            return Ok(SynthesisResult {
                samples: Vec::new(),
                sample_rate,
            });
        }

        let ids = intersperse_ids(&phonemes, model.pad, model.bos, model.eos);
        let len = ids.len();
        let input = Array2::from_shape_vec((1, len), ids)?;
        let lengths = arr1(&[len as i64]);
        let inference = &model.config.inference;
        let scales = arr1(&[
            inference.noise_scale,
            inference.length_scale / speed.max(0.1),
            inference.noise_w,
        ]);

        let outputs = if model.config.num_speakers > 1 {
            let sid = speaker
                .and_then(|name| model.config.speaker_id_map.get(name).copied())
                .unwrap_or(0);
            let sid = arr1(&[sid]);
            model.session.run(inputs![
                "input" => TensorRef::from_array_view(input.view())?,
                "input_lengths" => TensorRef::from_array_view(lengths.view())?,
                "scales" => TensorRef::from_array_view(scales.view())?,
                "sid" => TensorRef::from_array_view(sid.view())?,
            ])?
        } else {
            model.session.run(inputs![
                "input" => TensorRef::from_array_view(input.view())?,
                "input_lengths" => TensorRef::from_array_view(lengths.view())?,
                "scales" => TensorRef::from_array_view(scales.view())?,
            ])?
        };

        let (_, audio) = outputs
            .iter()
            .next()
            .ok_or_else(|| KokoroError::Ort(ort::Error::new("No output from model")))?;
        let samples = audio.try_extract_array::<f32>()?.iter().copied().collect();
        Ok(SynthesisResult {
            samples,
            sample_rate,
        })
    }
}

fn parse_config(json: &str) -> Result<PiperConfig, KokoroError> {
    serde_json::from_str(json).map_err(|e| KokoroError::Config(e.to_string()))
}

/// Piper maps each phoneme character to ids; multi-character keys are unused
/// for espeak phonemes.
fn single_char_vocab(map: &HashMap<String, Vec<i64>>) -> HashMap<char, i64> {
    map.iter()
        .filter_map(|(symbol, ids)| {
            let mut chars = symbol.chars();
            match (chars.next(), chars.next(), ids.first()) {
                (Some(ch), None, Some(&id)) => Some((ch, id)),
                _ => None,
            }
        })
        .collect()
}

/// Piper expects `BOS PAD p1 PAD p2 PAD ... EOS`.
fn intersperse_ids(phonemes: &[i64], pad: i64, bos: i64, eos: i64) -> Vec<i64> {
    let mut ids = Vec::with_capacity(phonemes.len() * 2 + 3);
    ids.push(bos);
    ids.push(pad);
    for &id in phonemes {
        ids.push(id);
        ids.push(pad);
    }
    ids.push(eos);
    ids
}

fn find_voice_files(model_dir: &Path) -> Result<(PathBuf, PathBuf), KokoroError> {
    for entry in std::fs::read_dir(model_dir)? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "onnx") {
            let config = PathBuf::from(format!("{}.json", path.display()));
            if config.exists() {
                return Ok((path, config));
            }
        }
    }
    Err(KokoroError::Io(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!(
            "No <voice>.onnx + <voice>.onnx.json pair in {}",
            model_dir.display()
        ),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r#"{
        "audio": {"sample_rate": 22050},
        "espeak": {"voice": "en-us"},
        "inference": {"noise_scale": 0.5, "length_scale": 1.2, "noise_w": 0.7},
        "phoneme_id_map": {"_": [0], "^": [1], "$": [2], " ": [3], "a": [14], "ˈ": [120], "ab": [99]},
        "num_speakers": 2,
        "speaker_id_map": {"bob": 1, "alice": 0}
    }"#;

    #[test]
    fn parses_voice_config() {
        let config = parse_config(CONFIG).unwrap();
        assert_eq!(config.audio.sample_rate, 22050);
        assert_eq!(config.espeak.voice, "en-us");
        assert_eq!(config.inference.length_scale, 1.2);
        assert_eq!(config.num_speakers, 2);
    }

    #[test]
    fn inference_defaults_when_missing() {
        let config = parse_config(
            r#"{"audio": {"sample_rate": 16000}, "espeak": {"voice": "de"}, "phoneme_id_map": {}}"#,
        )
        .unwrap();
        assert_eq!(config.inference.noise_scale, 0.667);
        assert_eq!(config.num_speakers, 0);
    }

    #[test]
    fn vocab_keeps_single_characters_only() {
        let vocab = single_char_vocab(&parse_config(CONFIG).unwrap().phoneme_id_map);
        assert_eq!(vocab.get(&'a'), Some(&14));
        assert_eq!(vocab.get(&'ˈ'), Some(&120));
        assert_eq!(vocab.len(), 6);
    }

    #[test]
    fn ids_are_padded_and_framed() {
        assert_eq!(
            intersperse_ids(&[14, 3], 0, 1, 2),
            vec![1, 0, 14, 0, 3, 0, 2]
        );
    }

    /// Set `PIPER_TEST_MODEL_DIR` to a downloaded voice directory to run.
    #[test]
    fn synthesizes_with_real_voice() {
        let Ok(dir) = std::env::var("PIPER_TEST_MODEL_DIR") else {
            return;
        };
        let mut engine = PiperEngine::default();
        engine.load_model(Path::new(&dir), Some(2)).unwrap();
        let normal = engine.synthesize("Hello from Piper.", 1.0, None).unwrap();
        assert!(normal.duration_secs() > 0.3);
        assert!(normal.samples.iter().any(|s| s.abs() > 0.01));
        let fast = engine.synthesize("Hello from Piper.", 2.0, None).unwrap();
        assert!(fast.samples.len() < normal.samples.len());
    }
}
