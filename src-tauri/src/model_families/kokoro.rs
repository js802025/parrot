use tts_rs::{
    engines::kokoro::{KokoroEngine, KokoroInferenceParams, KokoroModelParams},
    SynthesisEngine, SynthesisResult,
};

use super::{HfRepo, LoadContext, ModelFamily, SpeechEngine};
use crate::managers::model::{
    downloadable_model, file_name, kokoro_languages, EngineType, ModelInfo,
};

pub struct Kokoro;

impl ModelFamily for Kokoro {
    fn engine_type(&self) -> EngineType {
        EngineType::Kokoro
    }

    fn layout(&self) -> &'static str {
        "Kokoro ONNX models (.onnx + voices*.bin)"
    }

    fn detect(&self, repo: &HfRepo) -> Vec<ModelInfo> {
        let voices = repo.paths().find(|path| {
            let name = file_name(path);
            name.starts_with("voices") && name.ends_with(".bin")
        });
        let onnx = repo
            .paths()
            .filter(|path| path.ends_with(".onnx"))
            .min_by_key(|path| repo.size(path).unwrap_or(u64::MAX));
        let (Some(onnx), Some(voices)) = (onnx, voices) else {
            return Vec::new();
        };
        vec![downloadable_model(
            repo.slug(),
            repo.id.rsplit('/').next().unwrap_or(repo.id).to_string(),
            format!("Kokoro model from {}", repo.id),
            EngineType::Kokoro,
            kokoro_languages(),
            vec![
                repo.component(onnx, file_name(onnx)),
                repo.component(voices, "voices-v1.0.bin".to_string()),
            ],
            (0.8, 0.85),
            false,
        )]
    }

    fn load(&self, ctx: &LoadContext) -> Result<Box<dyn SpeechEngine>, String> {
        let mut engine = KokoroEngine::with_espeak(ctx.espeak_bin.clone(), ctx.espeak_data.clone());
        engine
            .load_model_with_params(
                ctx.model_dir,
                KokoroModelParams {
                    num_threads: Some(ctx.num_threads),
                    optimized_model_cache_path: ctx
                        .cache_dir
                        .as_ref()
                        .map(|dir| dir.join("kokoro-optimized.onnx")),
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(Box::new(engine))
    }
}

impl SpeechEngine for KokoroEngine {
    fn list_voices(&self) -> Vec<String> {
        KokoroEngine::list_voices(self)
            .into_iter()
            .map(String::from)
            .collect()
    }

    fn default_voice(&self) -> String {
        "af_heart".to_string()
    }

    fn synthesize(
        &mut self,
        text: &str,
        voice: &str,
        style_index: usize,
        speed: f32,
    ) -> Result<SynthesisResult, String> {
        SynthesisEngine::synthesize(
            self,
            text,
            Some(KokoroInferenceParams {
                voice: voice.to_string(),
                style_index: Some(style_index),
                speed,
            }),
        )
        .map_err(|e| e.to_string())
    }
}
