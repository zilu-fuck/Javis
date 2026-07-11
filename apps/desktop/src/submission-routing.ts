export type RuntimeStartMode = "chat" | "project" | undefined;

export function resolveVisionBridgeRuntimeMode(
  startMode: RuntimeStartMode,
  bridgeUsed: boolean,
): RuntimeStartMode {
  if (startMode === "project") {
    return "project";
  }
  return bridgeUsed ? "chat" : startMode;
}
