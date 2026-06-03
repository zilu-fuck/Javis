/**
 * Vision Bridge — desktop layer.
 *
 * When the primary model cannot process images, this module uses the
 * multimodal model to analyze each image and injects the analysis as
 * text context so the primary model can still "see" them.
 */

import {
  buildVisionBridgePrompt,
  formatVisionContext,
  stripImageMarkers,
  extractImageDataUrls,
  hasImageAttachments,
  modelSupportsVision,
} from "@javis/core";
import type { ModelProfile } from "./model-settings";
import { createModelProviderFromProfile } from "./model-provider";
import type { CompletionResult } from "./model-provider";

export interface VisionBridgeInput {
  userMessage: string;
  primaryProfile: ModelProfile;
  multimodalProfile: ModelProfile;
  locale: string;
  onProgress?: (msg: string) => void;
}

export interface VisionBridgeOutput {
  /** The enriched message text — vision context injected, image markers stripped. */
  enrichedMessage: string;
  /** Whether a bridge was actually used (false when primary already has vision). */
  bridgeUsed: boolean;
}

/**
 * Main entry point. If the primary model lacks vision AND the message
 * contains image attachments, analyze each image with the multimodal model
 * and inject the resulting notes as text context.
 */
export async function bridgeVisionIfNeeded(
  input: VisionBridgeInput,
): Promise<VisionBridgeOutput> {
  // Fast path: primary model can see images on its own.
  if (modelSupportsVision(input.primaryProfile.capabilities)) {
    return {
      enrichedMessage: input.userMessage,
      bridgeUsed: false,
    };
  }

  // Fast path: no images to bridge.
  if (!hasImageAttachments(input.userMessage)) {
    return { enrichedMessage: input.userMessage, bridgeUsed: false };
  }

  const imageUrls = extractImageDataUrls(input.userMessage);
  if (imageUrls.length === 0) {
    return { enrichedMessage: input.userMessage, bridgeUsed: false };
  }

  // Bridge path: need a configured multimodal model.
  if (
    !input.multimodalProfile?.model?.trim() ||
    !modelSupportsVision(input.multimodalProfile.capabilities)
  ) {
    const base = stripImageMarkers(input.userMessage).trim();
    return {
      enrichedMessage:
        base ||
        "[Javis: image received but no vision-capable model is configured. " +
        "Open Settings → AI and set up the Multimodal slot.]",
      bridgeUsed: false,
    };
  }

  const visionProvider = createModelProviderFromProfile(input.multimodalProfile);
  const cleanMessage = stripImageMarkers(input.userMessage).trim();
  const notes: string[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    input.onProgress?.(
      `Analyzing image ${i + 1}/${imageUrls.length}…`,
    );
    try {
      const result: CompletionResult = await visionProvider.complete(
        buildVisionBridgePrompt(cleanMessage),
        {
          imageDataUrl: imageUrls[i],
          maxTokens: 2048,
          temperature: 0.1,
          locale: input.locale,
        },
      );
      notes.push(result.text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      notes.push(`[vision analysis failed: ${msg}]`);
    }
  }

  if (notes.length === 0) {
    return { enrichedMessage: cleanMessage, bridgeUsed: false };
  }

  const visionContext = formatVisionContext(notes);
  const enriched = cleanMessage
    ? `${visionContext}\n\n${cleanMessage}`
    : visionContext;

  return { enrichedMessage: enriched, bridgeUsed: true };
}
