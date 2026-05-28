/** Strip trailing slashes from a base URL. Shared across adapters. */
export function normalizeBaseUrl(baseUrl: string): string {
  if (!baseUrl) return baseUrl;
  return baseUrl.replace(/\/+$/, "");
}
