import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelCatalogSchema, type ModelCatalog } from "../config/config-schema.js";
import type { ModelProfile } from "../domain/model-profile.js";

export function defaultCatalogPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../config/models.json");
}

export function loadModelCatalog(catalogPath: string = defaultCatalogPath()): ModelCatalog {
  const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
  return ModelCatalogSchema.parse(raw);
}

/**
 * Adds the user's `config.json` `models` to the built-in catalog. User models are additive:
 * redefining a built-in ID would silently change routing for everyone reading the docs, so a
 * clash is an error that names the ID and where it came from.
 */
export function mergeUserModels(catalog: ModelCatalog, userModels: ModelProfile[]): ModelCatalog {
  const builtIn = new Set<string>(catalog.models.map((model) => model.id));
  const seen = new Set<string>();
  userModels.forEach((model, index) => {
    if (builtIn.has(model.id)) {
      throw new Error(
        `config.json models[${index}] id "${model.id}" is already a built-in model; ` +
          "use a different id (for example a provider prefix of your own).",
      );
    }
    if (seen.has(model.id)) {
      throw new Error(
        `config.json models[${index}] id "${model.id}" is listed more than once in models.`,
      );
    }
    seen.add(model.id);
  });
  return { ...catalog, models: [...catalog.models, ...userModels] };
}

/** Built-in catalog plus the user's models: what `router run` routes over. */
export function loadEffectiveCatalog(
  userModels: ModelProfile[],
  catalogPath: string = defaultCatalogPath(),
): ModelCatalog {
  return mergeUserModels(loadModelCatalog(catalogPath), userModels);
}

/** Enabled model IDs that no catalog entry defines; such IDs are never routed to. */
export function unknownEnabledModels(
  catalog: ModelCatalog,
  accounts: Array<{ id: string; enabledModels: readonly string[] }>,
): Array<{ accountId: string; modelId: string }> {
  const known = new Set<string>(catalog.models.map((model) => model.id));
  return accounts.flatMap((account) =>
    account.enabledModels
      .filter((modelId) => !known.has(modelId))
      .map((modelId) => ({ accountId: account.id, modelId })),
  );
}
