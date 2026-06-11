function sanitizeMcpToolServerName(value: string): string {
  return [...value].filter((ch) => /[A-Za-z0-9._-]/.test(ch)).join("").slice(0, 96);
}

export function encodeMcpToolServerName(value: string): string {
  const trimmed = value.trim();
  const safeName = sanitizeMcpToolServerName(trimmed);
  if (safeName && safeName === trimmed && !safeName.startsWith("u_")) {
    return safeName;
  }
  const bytes = new TextEncoder().encode(trimmed);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
  return encoded ? `u_${encoded}` : "";
}

export function decodeMcpToolServerName(value: string): string {
  if (!value.startsWith("u_")) {
    return value;
  }
  const encoded = value.slice(2);
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}
