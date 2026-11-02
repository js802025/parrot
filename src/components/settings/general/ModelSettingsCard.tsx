import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { LanguageSelector } from "../LanguageSelector";
import {
  VoiceSelector,
  downloadedGroupModels,
  useModelVoices,
} from "../VoiceSelector";
import { useModelStore } from "../../../stores/modelStore";
import type { ModelInfo } from "@/bindings";

export const ModelSettingsCard: React.FC = () => {
  const { t } = useTranslation();
  const { currentModel, models } = useModelStore();
  const currentModelInfo = models.find((m: ModelInfo) => m.id === currentModel);
  const { voices, loadVoices } = useModelVoices(
    currentModelInfo?.is_downloaded ? currentModel : null,
  );

  if (!currentModel || !currentModelInfo) {
    return null;
  }

  const isKokoro = currentModelInfo.engine_type === "Kokoro";
  const hasSettings =
    isKokoro ||
    voices.length > 1 ||
    downloadedGroupModels(currentModelInfo, models).length > 1;

  return (
    <SettingsGroup
      title={t("settings.modelSettings.title", {
        model: currentModelInfo.name,
      })}
    >
      {isKokoro && (
        <LanguageSelector
          descriptionMode="tooltip"
          grouped={true}
          supportedLanguages={currentModelInfo.supported_languages}
        />
      )}
      {hasSettings ? (
        <VoiceSelector
          model={currentModelInfo}
          voices={voices}
          onRefresh={loadVoices}
          descriptionMode="tooltip"
          grouped={true}
        />
      ) : (
        <p className="px-4 py-3 text-sm text-text/60">
          {t("settings.modelSettings.noSettingsNeeded")}
        </p>
      )}
    </SettingsGroup>
  );
};
