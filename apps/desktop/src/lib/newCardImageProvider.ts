import { generationProviderIssue, type GenerationAvailabilityState } from "./generationAvailability";
import { defaultCloudProvider, genProviders, imageProviderSource, isCloudProvider } from "./genProviders";
import { modelFavoriteKey, useModelFavorites } from "./modelFavorites";

interface ImagePreferences extends GenerationAvailabilityState {
  defaultProvider: string;
  imageDefaultOrigin: "pin" | "legacy" | null;
  sessionImageProvider: string | null;
}

export function resolveNewCardImageProvider(state: ImagePreferences, favorites = useModelFavorites.getState().keys): string {
  const available = (key: string) => (!isCloudProvider(key) || key.startsWith("bowerbird-cloud-image_"))
    && !generationProviderIssue(key, state);
  if (state.imageDefaultOrigin === "pin" && available(state.defaultProvider)) return state.defaultProvider;
  if (state.sessionImageProvider && available(state.sessionImageProvider)) return state.sessionImageProvider;

  if (favorites.length) {
    const imageKeys = new Map(genProviders(state.cloudEntitlement).map(({ key }) => [
      modelFavoriteKey("图像", imageProviderSource(key), key), key,
    ]));
    for (const favorite of favorites) {
      const key = imageKeys.get(favorite);
      if (key && available(key)) return key;
    }
  }
  // Preserve an older saved preference until the user supplies a current choice.
  if (state.imageDefaultOrigin === "legacy" && available(state.defaultProvider)) return state.defaultProvider;
  return defaultCloudProvider(state.cloudEntitlement);
}
