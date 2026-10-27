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
  }),
  model({
    id: "piper-de_DE-thorsten-high",
    name: "Piper thorsten (high)",
    description: "German (Germany)",
    supported_languages: ["de"],
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
    await expect(page.getByText("Piper lessac (medium)")).toBeVisible();
    await expect(page.getByText("Piper thorsten (high)")).toBeVisible();

    const calls = await invokeCalls(page);
    expect(calls.map((c) => c.cmd)).toContain("refresh_model_catalog");
  });

  test("search filters the model list", async ({ page }) => {
    await mockTauri(page, {
      get_available_models: models,
      get_current_model: "kokoro",
    });
    await openModels(page);
    await page.getByPlaceholder("Search models").fill("german");
    await expect(page.getByText("Piper thorsten (high)")).toBeVisible();
    await expect(page.getByText("Piper lessac (medium)")).toHaveCount(0);
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
});
