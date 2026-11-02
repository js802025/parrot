import { test, expect } from "@playwright/test";
import { mockTauri, invokeCalls } from "./tauri-mock";

const model = (overrides: Record<string, unknown>) => ({
  description: "",
  filename: "",
  url: null,
  size_mb: 60,
  is_downloaded: false,
  is_downloading: false,
  partial_size: 0,
  is_directory: true,
  engine_type: "Piper",
  accuracy_score: 0.7,
  speed_score: 0.8,
  is_recommended: false,
  supported_languages: ["en"],
  is_custom: false,
  components: [],
  ...overrides,
});

const piper = { id: "piper", name: "Piper" };

const models = [
  model({
    id: "kokoro",
    name: "Kokoro-82M",
    description: "Fast and accurate",
    engine_type: "Kokoro",
    is_downloaded: true,
    is_recommended: true,
  }),
  model({
    id: "piper-en_US-lessac-medium",
    name: "Piper lessac (medium)",
    description: "English (United States)",
    group: piper,
  }),
  model({
    id: "piper-de_DE-thorsten-high",
    name: "Piper thorsten (high)",
    description: "German (Germany)",
    supported_languages: ["de"],
    group: piper,
  }),
];

async function openModels(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("Models", { exact: true }).first().click();
  await expect(page.getByText("Kokoro-82M").first()).toBeVisible();
}

test.describe("Models page with Hugging Face models", () => {
  test("lists Piper voices next to Kokoro and refreshes the catalog", async ({
    page,
  }) => {
    await mockTauri(page, {
      get_available_models: models,
      get_current_model: "kokoro",
    });
    await openModels(page);
    const group = page.getByTestId("model-group-piper");
    await expect(group).toHaveCount(1);
    await expect(group).toContainText("2 voices · 2 languages");
    await expect(
      page.getByText("lessac (medium)", { exact: false }),
    ).toHaveCount(0);

    await group.getByRole("button", { name: /Show voices/ }).click();
    await expect(
      group.getByText("lessac (medium) · English (United States)"),
    ).toBeVisible();
    await group
      .getByTestId("group-voice-piper-de_DE-thorsten-high")
      .getByRole("button")
      .click();

    const calls = await invokeCalls(page);
    expect(calls.map((c) => c.cmd)).toContain("refresh_model_catalog");
    expect(calls).toContainEqual({
      cmd: "download_model",
      args: { modelId: "piper-de_DE-thorsten-high" },
    });
  });

  test("search filters the model list", async ({ page }) => {
    await mockTauri(page, {
      get_available_models: models,
      get_current_model: "kokoro",
    });
    await openModels(page);
    await page.getByPlaceholder("Search models").fill("german");
    await expect(
      page.getByText("thorsten (high) · German (Germany)"),
    ).toBeVisible();
    await expect(page.getByText(/lessac/)).toHaveCount(0);
  });

  test("adds a model by Hugging Face repo id", async ({ page }) => {
    await mockTauri(page, {
      get_available_models: models,
      get_current_model: "kokoro",
      add_huggingface_model: [],
    });
    await openModels(page);
    const input = page.getByPlaceholder("owner/model or huggingface.co URL");
    await input.fill("rhasspy/piper-voices");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(input).toHaveValue("");

    const calls = await invokeCalls(page);
    expect(calls).toContainEqual({
      cmd: "add_huggingface_model",
      args: { repo: "rhasspy/piper-voices" },
    });
  });

  test("shows why an unsupported repo can't be added", async ({ page }) => {
    await mockTauri(page, {
      get_available_models: models,
      get_current_model: "kokoro",
      add_huggingface_model: {
        __error: "someone/llm has no model Parrot can run.",
      },
    });
    await openModels(page);
    await page
      .getByPlaceholder("owner/model or huggingface.co URL")
      .fill("someone/llm");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "someone/llm has no model Parrot can run.",
    );
  });

  test("switches between downloaded Piper voices from General settings", async ({
    page,
  }) => {
    const downloaded = models.map((m) =>
      m.group ? { ...m, is_downloaded: true } : m,
    );
    await mockTauri(page, {
      get_available_models: downloaded,
      get_current_model: "piper-en_US-lessac-medium",
      get_voices: ["lessac"],
    });
    await page.goto("/");
    const picker = page.getByRole("button", {
      name: "lessac (medium) · English (United States)",
    });
    await expect(picker).toBeVisible();
    await expect(page.getByText("Speaker", { exact: true })).toHaveCount(0);
    await picker.click();
    await page.getByText("thorsten (high) · German (Germany)").click();

    const calls = await invokeCalls(page);
    expect(calls).toContainEqual({
      cmd: "set_active_model",
      args: { modelId: "piper-de_DE-thorsten-high" },
    });
  });
});
