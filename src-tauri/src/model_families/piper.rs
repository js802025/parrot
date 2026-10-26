use tts_rs::{engines::piper::PiperEngine, SynthesisResult};

use super::{HfRepo, LoadContext, ModelFamily, SpeechEngine};
use crate::managers::model::{downloadable_model, file_name, EngineType, ModelInfo};

pub struct Piper;

impl ModelFamily for Piper {
    fn engine_type(&self) -> EngineType {
        EngineType::Piper
    }

    fn layout(&self) -> &'static str {
        "Piper voices (<voice>.onnx + <voice>.onnx.json)"
    }

    fn detect(&self, repo: &HfRepo) -> Vec<ModelInfo> {
        repo.paths()
            .filter(|path| path.ends_with(".onnx") && repo.has_file(&format!("{path}.json")))
            .map(|onnx| {
                let onnx_name = file_name(onnx);
                let stem = onnx_name.trim_end_matches(".onnx").to_string();
                downloadable_model(
                    format!("{}--{stem}", repo.slug()),
                    stem,
                    format!("Piper voice from {}", repo.id),
                    EngineType::Piper,
                    Vec::new(),
                    vec![
                        repo.component(onnx, onnx_name.clone()),
                        repo.component(&format!("{onnx}.json"), format!("{onnx_name}.json")),
                    ],
                    (0.7, 0.8),
                    false,
                )
            })
            .collect()
    }

    fn load(&self, ctx: &LoadContext) -> Result<Box<dyn SpeechEngine>, String> {
        let mut engine = PiperEngine::with_espeak(ctx.espeak_bin.clone(), ctx.espeak_data.clone());
        engine
            .load_model(ctx.model_dir, Some(ctx.num_threads))
            .map_err(|e| e.to_string())?;
        Ok(Box::new(engine))
    }
}

impl SpeechEngine for PiperEngine {
    fn list_voices(&self) -> Vec<String> {
        self.list_speakers()
    }

    fn synthesize(
        &mut self,
        text: &str,
        voice: &str,
        _style_index: usize,
        speed: f32,
    ) -> Result<SynthesisResult, String> {
        PiperEngine::synthesize(self, text, speed, Some(voice)).map_err(|e| e.to_string())
    }
}
