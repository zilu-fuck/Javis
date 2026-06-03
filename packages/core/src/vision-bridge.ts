/**
 * Vision Bridge — pure utility functions for image-in-chat routing.
 *
 * When a chat message contains image attachments but the primary model
 * lacks vision capability, these helpers orchestrate a bridge: the
 * multimodal model analyzes the images first, then the analysis is
 * injected as text context so the primary model can "see" them.
 *
 * This file is pure TypeScript — no Tauri, no LLM calls, no side effects.
 */

/** Extracts data URLs from a message that uses the `[image: <url>]` convention. */
export function extractImageDataUrls(message: string): string[] {
  const re = /\[image:\s*(data:[^\]]+)\]/gi;
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(message)) !== null) {
    urls.push(match[1].trim());
  }
  return urls;
}

/** Returns true when the message contains `[image: ...]` markers. */
export function hasImageAttachments(message: string): boolean {
  return /\[image:\s*data:/i.test(message);
}

/** Remove all `[image: ...]` markers so the primary model never sees raw data URLs. */
export function stripImageMarkers(message: string): string {
  return message.replace(/\[image:\s*data:[^\]]+\]\n?/gi, "");
}

/**
 * Build the prompt that the multimodal model uses when acting as a vision
 * bridge for a text-only primary model.
 */
export function buildVisionBridgePrompt(userRequest: string): string {
  return [
    "Analyze this image for another text-only model. Return a concise structured note:",
    "",
    "image_overview: what the image is about.",
    "visible_text: any readable text in the image (quote exactly when possible).",
    "objects_and_layout: key objects, people, UI elements, and their positions.",
    "charts_or_data: if the image contains charts, tables, or structured data, describe them.",
    "",
    `The user asked: "${userRequest}"`,
    "user_request_answer: answer the user's question based on what you see in the image.",
  ].join("\n");
}

/**
 * Wrap vision analysis notes in XML-style tags so the primary text-only
 * model can parse them as structured context.
 */
export function formatVisionContext(notes: string[]): string {
  const entries = notes
    .map((note, i) => `<image-${i + 1}>\n${note}\n</image-${i + 1}>`)
    .join("\n\n");
  return `<vision-context>\n${entries}\n</vision-context>`;
}

/** Check whether a model profile's capabilities include vision. */
export function modelSupportsVision(capabilities: {
  vision?: boolean;
}): boolean {
  return capabilities.vision === true;
}

/**
 * Remove `<vision-context>...</vision-context>` tags from display text.
 * These tags carry internal analysis for the primary model and should
 * never be rendered to the user.
 */
export function stripVisionContextMarkers(text: string): string {
  return text.replace(/<vision-context>[\s\S]*?<\/vision-context>\n?/gi, "").trim();
}
