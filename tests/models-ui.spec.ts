import { test, expect } from "@playwright/test";
import { mockTauri, invokeCalls } from "./tauri-mock";

const model = (overrides: Record<string, unknown>) => ({
  description: "",
  filename: "",
  url: null,
  size_mb: 115,
  is_downloaded: false,
  is_downloading: false,
  partial_size: 0,
  is_directory: true,
  engine_type: "Kokoro",
  accuracy_score: 0.8,
  speed_score: 0.85,
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
    is_downloaded: true,
    is_recommended: true,
  }),
];

async function openModels(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("Models", { exact: true }).first().click();
  await expect(page.getByText("Kokoro-82M").first()).toBeVisible();
}

test.describe("Models page", () => {
  test("lists Kokoro without Piper voices or a search bar", async ({
    page,
  }) => {
    await mockTauri(page, {
      get_available_models: models,
      get_current_model: "kokoro",
    });
    await openModels(page);
    await expect(page.getByPlaceholder("Search models")).toHaveCount(0);

    const calls = await invokeCalls(page);
    expect(calls.map((c) => c.cmd)).not.toContain("refresh_model_catalog");
  });

  test("adds a model by Hugging Face repo id", async ({ page }) => {
    await mockTauri(page, {
      get_available_models: models,
      get_current_model: "kokoro",
      add_huggingface_model: [],
    });
    await openModels(page);
    const input = page.getByPlaceholder("owner/model or huggingface.co URL");
    await input.fill("onnx-community/Kokoro-82M-v1.0-ONNX");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(input).toHaveValue("");

    const calls = await invokeCalls(page);
    expect(calls).toContainEqual({
      cmd: "add_huggingface_model",
      args: { repo: "onnx-community/Kokoro-82M-v1.0-ONNX" },
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
