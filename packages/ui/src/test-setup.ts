if (typeof globalThis.self === "undefined") {
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: globalThis,
  });
}

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return null;
  };
}
