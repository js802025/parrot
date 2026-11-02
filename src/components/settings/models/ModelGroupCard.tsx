import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Download, Loader2, Trash2, X } from "lucide-react";
import type { ModelGroup, ModelInfo } from "@/bindings";
import type { ModelCardStatus } from "@/components/onboarding";
import { formatModelSize } from "../../../lib/utils/format";
import Badge from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { groupedModelLabel } from "../VoiceSelector";

interface ModelGroupCardProps {
  group: ModelGroup;
  models: ModelInfo[];
  defaultOpen: boolean;
  getStatus: (modelId: string) => ModelCardStatus;
  getProgress: (modelId: string) => number | undefined;
  onSelect: (modelId: string) => void;
  onDownload: (modelId: string) => void;
  onDelete: (modelId: string) => void;
  onCancel: (modelId: string) => void;
}

/** One entry for a group of models (e.g. Piper voices) with a voice list. */
export const ModelGroupCard: React.FC<ModelGroupCardProps> = ({
  group,
  models,
  defaultOpen,
  getStatus,
  getProgress,
  onSelect,
  onDownload,
  onDelete,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);

  const statuses = models.map((m) => getStatus(m.id));
  const isActive = statuses.includes("active");
  const languageCount = new Set(models.flatMap((m) => m.supported_languages))
    .size;

  return (
    <div
      data-testid={`model-group-${group.id}`}
      className={`flex flex-col rounded-xl px-4 py-3 gap-2 border-2 ${
        isActive
          ? "border-logo-primary/50 bg-logo-primary/10"
          : "border-mid-gray/20"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex flex-col items-start min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h3 className="text-base font-semibold text-text">{group.name}</h3>
            {isActive && (
              <Badge variant="primary">
                <Check className="w-3 h-3 mr-1" />
                {t("modelSelector.active")}
              </Badge>
            )}
          </div>
          <p className="text-text/60 text-sm">
            {t("settings.models.group.voiceCount", { count: models.length })}
            {languageCount > 1 &&
              ` · ${t("settings.models.group.languageCount", { count: languageCount })}`}
          </p>
        </div>
        <span className="flex items-center gap-1 text-xs text-text/50">
          {open
            ? t("settings.models.group.hide")
            : t("settings.models.group.show")}
          <ChevronDown
            className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && (
        <ul className="flex flex-col divide-y divide-mid-gray/20 border-t border-mid-gray/20">
          {models.map((model, index) => {
            const status = statuses[index];
            const progress = getProgress(model.id);
            const label = groupedModelLabel(model);
            return (
              <li
                key={model.id}
                data-testid={`group-voice-${model.id}`}
                className="flex items-center gap-3 py-2"
              >
                <span className="flex-1 min-w-0 text-sm truncate" title={label}>
                  {label}
                </span>
                {status === "downloadable" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDownload(model.id)}
                    className="flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{formatModelSize(Number(model.size_mb))}</span>
                  </Button>
                )}
                {(status === "downloading" || status === "extracting") && (
                  <span className="flex items-center gap-1.5 text-xs text-text/50">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {progress !== undefined && `${Math.round(progress)}%`}
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      onClick={() => onCancel(model.id)}
                      title={t("modelSelector.cancel")}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </span>
                )}
                {status === "switching" && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-text/50" />
                )}
                {status === "available" && (
                  <Button
                    variant="primary-soft"
                    size="sm"
                    onClick={() => onSelect(model.id)}
                  >
                    {t("settings.models.group.use")}
                  </Button>
                )}
                {status === "active" && (
                  <Badge variant="primary">{t("modelSelector.active")}</Badge>
                )}
                {(status === "available" || status === "active") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(model.id)}
                    title={t("modelSelector.deleteModel", { modelName: label })}
                    className="text-logo-primary/85 hover:text-logo-primary"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
