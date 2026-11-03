import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ask } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Globe, Search } from "lucide-react";
import type { ModelCardStatus } from "@/components/onboarding";
import { ModelCard } from "@/components/onboarding";
import { useModelStore } from "@/stores/modelStore";
import { LANGUAGES } from "@/lib/constants/languages.ts";
import { commands, type ModelGroup, type ModelInfo } from "@/bindings";
import { ModelGroupCard } from "./ModelGroupCard";

type ModelListEntry =
  | { kind: "model"; model: ModelInfo }
  | { kind: "group"; group: ModelGroup; models: ModelInfo[] };

/** Collapse models that share a group into one entry, keeping list order. */
const groupModels = (models: ModelInfo[]): ModelListEntry[] => {
  const entries: ModelListEntry[] = [];
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    if (!model.group) {
      entries.push({ kind: "model", model });
      continue;
    }
    const members = groups.get(model.group.id);
    if (members) {
      members.push(model);
    } else {
      const created = [model];
      groups.set(model.group.id, created);
      entries.push({ kind: "group", group: model.group, models: created });
    }
  }
  return entries;
};

const SUPPORTED_ENGINE_TYPES: ModelInfo["engine_type"][] = ["Kokoro", "Piper"];

const isSupportedModel = (model: ModelInfo): boolean => {
  return SUPPORTED_ENGINE_TYPES.includes(model.engine_type);
};

const matchesSearch = (model: ModelInfo, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return (
    !needle ||
    `${model.name} ${model.description} ${model.id}`
      .toLowerCase()
      .includes(needle)
  );
};

// check if model supports a language based on its supported_languages list
const modelSupportsLanguage = (model: ModelInfo, langCode: string): boolean => {
  return model.supported_languages.includes(langCode);
};

export const ModelsSettings: React.FC = () => {
  const { t } = useTranslation();
  const [switchingModelId, setSwitchingModelId] = useState<string | null>(null);
  const [languageFilter, setLanguageFilter] = useState("all");
  const [languageDropdownOpen, setLanguageDropdownOpen] = useState(false);
  const [languageSearch, setLanguageSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [hfRepo, setHfRepo] = useState("");
  const [hfAdding, setHfAdding] = useState(false);
  const [hfError, setHfError] = useState<string | null>(null);
  const languageDropdownRef = useRef<HTMLDivElement>(null);
  const languageSearchInputRef = useRef<HTMLInputElement>(null);
  const {
    models,
    currentModel,
    downloadingModels,
    downloadProgress,
    downloadStats,
    extractingModels,
    loading,
    loadModels,
    downloadModel,
    cancelDownload,
    selectModel,
    deleteModel,
  } = useModelStore();
  const filteredEngineModels = useMemo(() => {
    return models.filter(isSupportedModel);
  }, [models]);

  useEffect(() => {
    commands.refreshModelCatalog().then((result) => {
      if (result.status === "ok") {
        loadModels();
      } else {
        console.warn("Hugging Face catalog refresh failed:", result.error);
      }
    });
  }, [loadModels]);

  const handleAddHuggingFaceModel = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!hfRepo.trim() || hfAdding) return;
    setHfAdding(true);
    setHfError(null);
    try {
      const result = await commands.addHuggingfaceModel(hfRepo);
      if (result.status === "ok") {
        setHfRepo("");
        await loadModels();
      } else {
        setHfError(result.error);
      }
    } finally {
      setHfAdding(false);
    }
  };

  // click outside handler for language dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        languageDropdownRef.current &&
        !languageDropdownRef.current.contains(event.target as Node)
      ) {
        setLanguageDropdownOpen(false);
        setLanguageSearch("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // focus search input when dropdown opens
  useEffect(() => {
    if (languageDropdownOpen && languageSearchInputRef.current) {
      languageSearchInputRef.current.focus();
    }
  }, [languageDropdownOpen]);

  // filtered languages for dropdown (exclude "auto")
  const filteredLanguages = useMemo(() => {
    return LANGUAGES.filter(
      (lang) =>
        lang.value !== "auto" &&
        lang.label.toLowerCase().includes(languageSearch.toLowerCase()),
    );
  }, [languageSearch]);

  // Get selected language label
  const selectedLanguageLabel = useMemo(() => {
    if (languageFilter === "all") {
      return t("settings.models.filters.allLanguages");
    }
    return LANGUAGES.find((lang) => lang.value === languageFilter)?.label || "";
  }, [languageFilter, t]);

  const getModelStatus = (modelId: string): ModelCardStatus => {
    if (modelId in extractingModels) {
      return "extracting";
    }
    if (modelId in downloadingModels) {
      return "downloading";
    }
    if (switchingModelId === modelId) {
      return "switching";
    }
    if (modelId === currentModel) {
      return "active";
    }
    const model = filteredEngineModels.find((m: ModelInfo) => m.id === modelId);
    if (model?.is_downloaded) {
      return "available";
    }
    return "downloadable";
  };

  const getDownloadProgress = (modelId: string): number | undefined => {
    const progress = downloadProgress[modelId];
    return progress?.percentage;
  };

  const getDownloadSpeed = (modelId: string): number | undefined => {
    const stats = downloadStats[modelId];
    return stats?.speed;
  };

  const handleModelSelect = async (modelId: string) => {
    setSwitchingModelId(modelId);
    try {
      await selectModel(modelId);
    } finally {
      setSwitchingModelId(null);
    }
  };

  const handleModelDownload = async (modelId: string) => {
    await downloadModel(modelId);
  };

  const handleModelDelete = async (modelId: string) => {
    const model = filteredEngineModels.find((m: ModelInfo) => m.id === modelId);
    const modelName = model?.name || modelId;
    const isActive = modelId === currentModel;

    const confirmed = await ask(
      isActive
        ? t("settings.models.deleteActiveConfirm", { modelName })
        : t("settings.models.deleteConfirm", { modelName }),
      {
        title: t("settings.models.deleteTitle"),
        kind: "warning",
      },
    );

    if (confirmed) {
      try {
        await deleteModel(modelId);
      } catch (err) {
        console.error(`Failed to delete model ${modelId}:`, err);
      }
    }
  };

  const handleModelCancel = async (modelId: string) => {
    try {
      await cancelDownload(modelId);
    } catch (err) {
      console.error(`Failed to cancel download for ${modelId}:`, err);
    }
  };

  // Filter models based on language filter
  const filteredModels = useMemo(() => {
    return filteredEngineModels.filter((model: ModelInfo) => {
      if (languageFilter !== "all") {
        if (!modelSupportsLanguage(model, languageFilter)) return false;
      }
      return matchesSearch(model, modelSearch);
    });
  }, [filteredEngineModels, languageFilter, modelSearch]);

  // One list: active model first, then downloaded/in-progress, then the rest.
  // Grouped models (e.g. Piper voices) stay together in one card.
  const sortedModels = useMemo(() => {
    const rank = (model: ModelInfo) => {
      if (model.id === currentModel) return 0;
      if (
        model.is_downloaded ||
        model.id in downloadingModels ||
        model.id in extractingModels
      )
        return 1;
      return model.is_custom ? 3 : 2;
    };
    return [...filteredModels].sort((a, b) => rank(a) - rank(b));
  }, [filteredModels, downloadingModels, extractingModels, currentModel]);

  const isFiltering = languageFilter !== "all" || modelSearch.trim() !== "";

  const renderEntry = (entry: ModelListEntry, defaultOpen: boolean) =>
    entry.kind === "group" ? (
      <ModelGroupCard
        key={`group-${entry.group.id}`}
        group={entry.group}
        models={entry.models}
        defaultOpen={defaultOpen}
        getStatus={getModelStatus}
        getProgress={getDownloadProgress}
        onSelect={handleModelSelect}
        onDownload={handleModelDownload}
        onDelete={handleModelDelete}
        onCancel={handleModelCancel}
      />
    ) : (
      <ModelCard
        key={entry.model.id}
        model={entry.model}
        status={getModelStatus(entry.model.id)}
        onSelect={handleModelSelect}
        onDownload={handleModelDownload}
        onDelete={handleModelDelete}
        onCancel={handleModelCancel}
        downloadProgress={getDownloadProgress(entry.model.id)}
        downloadSpeed={getDownloadSpeed(entry.model.id)}
        showRecommended={false}
      />
    );

  if (loading) {
    return (
      <div className="max-w-3xl w-full mx-auto">
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-logo-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl w-full mx-auto space-y-4">
      <div className="mb-4">
        <h1 className="text-xl font-semibold mb-2">
          {t("settings.models.title")}
        </h1>
        <p className="text-sm text-text/60">
          {t("settings.models.description")}
        </p>
      </div>
      <form
        onSubmit={handleAddHuggingFaceModel}
        className="space-y-2"
        data-testid="hf-add-form"
      >
        <h2 className="text-sm font-medium text-text/60">
          {t("settings.models.huggingFace.title")}
        </h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={hfRepo}
            onChange={(e) => setHfRepo(e.target.value)}
            placeholder={t("settings.models.huggingFace.placeholder")}
            className="flex-1 px-3 py-1.5 text-sm bg-mid-gray/10 border border-mid-gray/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-logo-primary"
          />
          <button
            type="submit"
            disabled={hfAdding || !hfRepo.trim()}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-logo-primary/20 text-logo-primary hover:bg-logo-primary/30 disabled:opacity-50"
          >
            {hfAdding
              ? t("settings.models.huggingFace.adding")
              : t("settings.models.huggingFace.add")}
          </button>
        </div>
        <p className="text-xs text-text/50">
          {t("settings.models.huggingFace.hint")}
        </p>
        {hfError && (
          <p className="text-xs text-red-400" role="alert">
            {hfError}
          </p>
        )}
      </form>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text/40" />
        <input
          type="search"
          value={modelSearch}
          onChange={(e) => setModelSearch(e.target.value)}
          placeholder={t("settings.models.searchPlaceholder")}
          className="w-full pl-8 pr-3 py-1.5 text-sm bg-mid-gray/10 border border-mid-gray/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-logo-primary"
        />
      </div>
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-text/60">
              {t("settings.models.allModels")}
            </h2>
            {/* Language filter dropdown */}
            <div className="relative" ref={languageDropdownRef}>
              <button
                type="button"
                onClick={() => setLanguageDropdownOpen(!languageDropdownOpen)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  languageFilter !== "all"
                    ? "bg-logo-primary/20 text-logo-primary"
                    : "bg-mid-gray/10 text-text/60 hover:bg-mid-gray/20"
                }`}
              >
                <Globe className="w-3.5 h-3.5" />
                <span className="max-w-[120px] truncate">
                  {selectedLanguageLabel}
                </span>
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform ${
                    languageDropdownOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              {languageDropdownOpen && (
                <div className="absolute top-full right-0 mt-1 w-56 bg-background border border-mid-gray/80 rounded-lg shadow-lg z-50 overflow-hidden">
                  <div className="p-2 border-b border-mid-gray/40">
                    <input
                      ref={languageSearchInputRef}
                      type="text"
                      value={languageSearch}
                      onChange={(e) => setLanguageSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && filteredLanguages.length > 0) {
                          setLanguageFilter(filteredLanguages[0].value);
                          setLanguageDropdownOpen(false);
                          setLanguageSearch("");
                        } else if (e.key === "Escape") {
                          setLanguageDropdownOpen(false);
                          setLanguageSearch("");
                        }
                      }}
                      placeholder={t(
                        "settings.general.language.searchPlaceholder",
                      )}
                      className="w-full px-2 py-1 text-sm bg-mid-gray/10 border border-mid-gray/40 rounded-md focus:outline-none focus:ring-1 focus:ring-logo-primary"
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    <button
                      type="button"
                      onClick={() => {
                        setLanguageFilter("all");
                        setLanguageDropdownOpen(false);
                        setLanguageSearch("");
                      }}
                      className={`w-full px-3 py-1.5 text-sm text-left transition-colors ${
                        languageFilter === "all"
                          ? "bg-logo-primary/20 text-logo-primary font-semibold"
                          : "hover:bg-mid-gray/10"
                      }`}
                    >
                      {t("settings.models.filters.allLanguages")}
                    </button>
                    {filteredLanguages.map((lang) => (
                      <button
                        key={lang.value}
                        type="button"
                        onClick={() => {
                          setLanguageFilter(lang.value);
                          setLanguageDropdownOpen(false);
                          setLanguageSearch("");
                        }}
                        className={`w-full px-3 py-1.5 text-sm text-left transition-colors ${
                          languageFilter === lang.value
                            ? "bg-logo-primary/20 text-logo-primary font-semibold"
                            : "hover:bg-mid-gray/10"
                        }`}
                      >
                        {lang.label}
                      </button>
                    ))}
                    {filteredLanguages.length === 0 && (
                      <div className="px-3 py-2 text-sm text-text/50 text-center">
                        {t("settings.general.language.noResults")}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          {groupModels(sortedModels).map((entry) =>
            renderEntry(entry, isFiltering),
          )}
        </div>

        {filteredModels.length === 0 && (
          <div className="text-center py-8 text-text/50">
            {t("settings.models.noModelsMatch")}
          </div>
        )}
      </div>
    </div>
  );
};
