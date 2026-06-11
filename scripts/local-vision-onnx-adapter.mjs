import { readFile, stat } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const DEFAULT_INPUT_SIZE = 640;
const MAX_INPUT_SIZE = 1_280;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.25;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_OUTPUT_ELEMENTS = 4_000_000;
const MAX_DETECTION_ROWS = 100_000;
const PNG_SIGNATURE = "89504e470d0a1a0a";
const injectedRuntimeSessionCaches = new WeakMap();

export async function detect({ request, imageSize, runtime }) {
  const ort = runtime ?? await loadOnnxRuntime();
  const modelPath = stringOrEmpty(request.modelPath);
  if (!modelPath) {
    throw new Error("ONNX adapter requires request.modelPath");
  }

  const { session, inputName, inputShape, cacheHit } = await getCachedSession(ort, modelPath);

  const requestedInputSize = normalizeInputSize(request.imgsz);
  const modelInputSize = fixedSquareInputSize(inputShape);
  const inputSize = modelInputSize ?? requestedInputSize;
  const { tensor: inputTensor, transform } = await createImageTensor(ort, request, inputSize);
  const outputs = await session.run({ [inputName]: inputTensor });
  const firstOutputName = session.outputNames?.[0] ?? Object.keys(outputs)[0];
  const outputTensor = outputs[firstOutputName];
  if (!outputTensor) {
    throw new Error("ONNX model returned no output tensor");
  }

  const decoded = decodeYoloOutputWithDiagnostics(outputTensor, imageSize, {
    inputSize,
    transform,
    minConfidence: request.minConfidence,
    labelMap: request.labelMap,
  });

  return {
    runtime: "onnxruntime",
    rawDetections: decoded.rawDetections,
    diagnostics: {
      ...decoded.diagnostics,
      inputName,
      inputDims: inputTensor.dims,
      requestedInputSize,
      inputSizeSource: modelInputSize ? "model" : "request",
      outputName: firstOutputName,
      outputDims: Array.isArray(outputTensor.dims) ? outputTensor.dims.map(Number) : [],
      sessionCacheHit: cacheHit,
    },
  };
}

async function loadOnnxRuntime() {
  try {
    return await import("onnxruntime-node");
  } catch (error) {
    throw new Error(
      `onnxruntime-node is not installed or could not be loaded: ${errorMessage(error)}`,
    );
  }
}

async function getCachedSession(ort, modelPath) {
  const cache = sessionCacheForRuntime(ort);
  const cached = cache.get(modelPath);
  if (cached) {
    return { ...await cached, cacheHit: true };
  }
  const created = createSessionEntry(ort, modelPath);
  cache.set(modelPath, created);
  try {
    return { ...await created, cacheHit: false };
  } catch (error) {
    cache.delete(modelPath);
    throw error;
  }
}

function sessionCacheForRuntime(ort) {
  if (!ort || (typeof ort !== "object" && typeof ort !== "function")) {
    return new Map();
  }
  let cache = injectedRuntimeSessionCaches.get(ort);
  if (!cache) {
    cache = new Map();
    injectedRuntimeSessionCaches.set(ort, cache);
  }
  return cache;
}

async function createSessionEntry(ort, modelPath) {
  const session = await ort.InferenceSession.create(modelPath);
  const inputName = session.inputNames?.[0];
  if (!inputName) {
    throw new Error("ONNX model has no input names");
  }
  return {
    session,
    inputName,
    inputShape: inputShapeForName(session, inputName),
  };
}

function inputShapeForName(session, inputName) {
  const metadata = Array.isArray(session.inputMetadata)
    ? session.inputMetadata.find((entry) => entry?.name === inputName) ?? session.inputMetadata[0]
    : undefined;
  return Array.isArray(metadata?.shape) ? metadata.shape.map((dim) => Number(dim)) : [];
}

function fixedSquareInputSize(shape) {
  if (!Array.isArray(shape) || shape.length < 4) return undefined;
  const height = shape[shape.length - 2];
  const width = shape[shape.length - 1];
  return Number.isFinite(height) && Number.isFinite(width) && height > 0 && width === height
    ? normalizeInputSize(height)
    : undefined;
}

async function createImageTensor(ort, request, inputSize) {
  const imagePath = stringOrEmpty(request.imagePath);
  if (!imagePath) {
    throw new Error("ONNX adapter requires request.imagePath");
  }
  const imageStat = await stat(imagePath);
  if (!imageStat.isFile()) {
    throw new Error("ONNX adapter imagePath is not a file");
  }
  if (imageStat.size > MAX_IMAGE_BYTES) {
    throw new Error(`ONNX adapter image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  const png = decodePng(await readFile(imagePath));
  const preprocessed = letterboxToNchwTensor(png, inputSize);
  return {
    tensor: new ort.Tensor("float32", preprocessed.data, [1, 3, inputSize, inputSize]),
    transform: preprocessed.transform,
  };
}

export function decodeYoloOutput(outputTensor, imageSize, options = {}) {
  return decodeYoloOutputWithDiagnostics(outputTensor, imageSize, options).rawDetections;
}

export function decodeYoloOutputWithDiagnostics(outputTensor, imageSize, options = {}) {
  const outputData = outputTensor.data ?? [];
  if (outputData.length > MAX_OUTPUT_ELEMENTS) {
    throw new Error(`ONNX adapter output tensor is too large: ${outputData.length} elements`);
  }
  const dims = Array.isArray(outputTensor.dims) ? outputTensor.dims.map(Number) : [];
  const extraction = extractDetectionRows(outputData, dims);
  if (extraction.layout === "unsupported") {
    throw new Error(
      `unsupported YOLO output tensor shape dims=${formatDims(dims)} elements=${outputData.length}: ${extraction.reason}`,
    );
  }
  const minConfidence = normalizeConfidenceThreshold(options.minConfidence);
  const inputSize = normalizeInputSize(options.inputSize);
  const transform = options.transform ?? createDefaultTransform(imageSize, inputSize);

  const rawDetections = [];
  for (let index = 0; index < extraction.rowCount; index += 1) {
    const detection = decodeDetectionRow(extraction, index, {
      minConfidence,
      transform,
      imageSize,
      labelMap: options.labelMap,
    });
    if (detection) rawDetections.push(detection);
  }
  return {
    rawDetections,
    diagnostics: {
      adapter: "onnxruntime",
      outputDims: dims,
      outputElementCount: outputData.length,
      outputLayout: extraction.layout,
      inputSize,
      rawRowCount: extraction.rowCount,
      decodedCount: rawDetections.length,
      filteredCount: Math.max(0, extraction.rowCount - rawDetections.length),
      minConfidence,
    },
  };
}

export function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    bytes = Buffer.from(bytes);
  }
  if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
    throw new Error("ONNX adapter expected a PNG image");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error("ONNX adapter PNG chunk is truncated");
    }
    const chunk = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === "IDAT") {
      idatChunks.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0) {
    throw new Error("ONNX adapter PNG dimensions are invalid");
  }
  if (imageExceedsPixelLimit(width, height)) {
    throw new Error(`ONNX adapter PNG exceeds ${MAX_IMAGE_PIXELS} pixels`);
  }
  if (bitDepth !== 8) {
    throw new Error(`ONNX adapter only supports 8-bit PNG images, got bit depth ${bitDepth}`);
  }
  if (interlace !== 0) {
    throw new Error("ONNX adapter does not support interlaced PNG images");
  }
  const channels = channelsForPngColorType(colorType);
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const expectedBytes = height * (1 + stride);
  if (inflated.length < expectedBytes) {
    throw new Error("ONNX adapter PNG image data is truncated");
  }

  const rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const row = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;
    unfilterPngRow(row, previous, channels, filter);
    writeRgbaRow(row, rgba, y, width, colorType);
    previous = row;
  }

  return { width, height, rgba };
}

function imageExceedsPixelLimit(width, height) {
  return width > 0 && height > Math.floor(MAX_IMAGE_PIXELS / width);
}

export function letterboxToNchwTensor(image, inputSize) {
  inputSize = normalizeInputSize(inputSize);
  const scale = Math.min(inputSize / image.width, inputSize / image.height);
  const resizedWidth = Math.max(1, Math.round(image.width * scale));
  const resizedHeight = Math.max(1, Math.round(image.height * scale));
  const padX = Math.floor((inputSize - resizedWidth) / 2);
  const padY = Math.floor((inputSize - resizedHeight) / 2);
  const planeSize = inputSize * inputSize;
  const data = new Float32Array(3 * planeSize);
  data.fill(114 / 255);

  for (let y = 0; y < inputSize; y += 1) {
    for (let x = 0; x < inputSize; x += 1) {
      if (x < padX || y < padY || x >= padX + resizedWidth || y >= padY + resizedHeight) {
        continue;
      }
      const sourceX = clamp(Math.floor((x - padX) / scale), 0, image.width - 1);
      const sourceY = clamp(Math.floor((y - padY) / scale), 0, image.height - 1);
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      const targetOffset = y * inputSize + x;
      data[targetOffset] = image.rgba[sourceOffset] / 255;
      data[planeSize + targetOffset] = image.rgba[sourceOffset + 1] / 255;
      data[planeSize * 2 + targetOffset] = image.rgba[sourceOffset + 2] / 255;
    }
  }

  return {
    data,
    transform: {
      scale,
      padX,
      padY,
      inputSize,
      sourceWidth: image.width,
      sourceHeight: image.height,
    },
  };
}

function extractDetectionRows(data, dims) {
  if (dims.length === 2) {
    return extractDetectionRows2d(data, dims[0], dims[1]);
  }
  if (dims.length === 3 && dims[0] === 1) {
    return extractDetectionRows2d(data, dims[1], dims[2]);
  }
  if (dims.length === 3) {
    return extractDetectionRows2d(data, dims[1], dims[2]);
  }
  return {
    layout: "unsupported",
    rowCount: 0,
    reason: `expected a 2D or 3D YOLO output tensor, got ${dims.length} dimensions`,
  };
}

function extractDetectionRows2d(data, first, second) {
  if (![first, second].every(Number.isFinite)) {
    return {
      layout: "unsupported",
      rowCount: 0,
      reason: `non-numeric output dimensions ${formatDims([first, second])}`,
    };
  }
  const firstLooksLikeAttributes = isLikelyYoloAttributeCount(first);
  const secondLooksLikeAttributes = isLikelyYoloAttributeCount(second);
  if (firstLooksLikeAttributes && !secondLooksLikeAttributes) {
    if (second > MAX_DETECTION_ROWS) {
      return oversizedRowsResult(second);
    }
    return {
      layout: "channel_major",
      data,
      rowCount: second,
      rowLength: first,
    };
  }
  if (secondLooksLikeAttributes) {
    const rows = Math.floor(data.length / second);
    if (rows > MAX_DETECTION_ROWS) {
      return oversizedRowsResult(rows);
    }
    return {
      layout: "row_major",
      data,
      rowCount: rows,
      rowLength: second,
    };
  }
  if (firstLooksLikeAttributes) {
    if (second > MAX_DETECTION_ROWS) {
      return oversizedRowsResult(second);
    }
    return {
      layout: "channel_major",
      data,
      rowCount: second,
      rowLength: first,
    };
  }
  return {
    layout: "unsupported",
    rowCount: 0,
    reason: `neither output dimension looks like YOLO attributes: ${formatDims([first, second])}`,
  };
}

function oversizedRowsResult(rows) {
  return {
    layout: "unsupported",
    rowCount: 0,
    reason: `YOLO output has too many candidate rows: ${rows}`,
  };
}

function isLikelyYoloAttributeCount(value) {
  return Number.isFinite(value) && value >= 5 && value <= 512;
}

function rowValue(extraction, rowIndex, attrIndex) {
  return extraction.layout === "channel_major"
    ? extraction.data[attrIndex * extraction.rowCount + rowIndex]
    : extraction.data[rowIndex * extraction.rowLength + attrIndex];
}

function decodeDetectionRow(extraction, index, options) {
  if (extraction.rowLength < 5) return undefined;
  const cx = rowValue(extraction, index, 0);
  const cy = rowValue(extraction, index, 1);
  const width = rowValue(extraction, index, 2);
  const height = rowValue(extraction, index, 3);
  if (![cx, cy, width, height].every(Number.isFinite)) return undefined;

  let confidence;
  let classIndex = 0;
  if (extraction.rowLength === 5) {
    confidence = rowValue(extraction, index, 4);
  } else if (inferYoloRowLayout(extraction.rowLength, options.labelMap) === "class_scores") {
    const best = bestClass(extraction, index, 4);
    confidence = best.score;
    classIndex = best.index;
  } else {
    const objectness = clamp(rowValue(extraction, index, 4), 0, 1);
    const best = bestClass(extraction, index, 5);
    confidence = objectness * best.score;
    classIndex = best.index;
  }
  if (!Number.isFinite(confidence) || confidence < options.minConfidence) {
    return undefined;
  }

  const transform = options.transform;
  const x = (cx - width / 2 - transform.padX) / transform.scale;
  const y = (cy - height / 2 - transform.padY) / transform.scale;
  const scaledWidth = width / transform.scale;
  const scaledHeight = height / transform.scale;
  return {
    id: `onnx_det_${index + 1}`,
    label: labelForClass(classIndex, options.labelMap),
    confidence,
    box: {
      x,
      y,
      width: scaledWidth,
      height: scaledHeight,
    },
  };
}

function inferYoloRowLayout(rowLength, labelMap) {
  const labelCount = Array.isArray(labelMap) ? labelMap.length : 0;
  if (labelCount > 0) {
    if (labelCount >= 2 && rowLength === 4 + labelCount) return "class_scores";
    if (rowLength === 5 + labelCount) return "objectness";
  }
  if (rowLength === 84) return "class_scores";
  if (rowLength === 85) return "objectness";
  return rowLength > 5 && rowLength < 85 ? "class_scores" : "objectness";
}

function createDefaultTransform(imageSize, inputSize) {
  return {
    scale: inputSize / Math.max(imageSize.width, imageSize.height),
    padX: imageSize.width >= imageSize.height ? 0 : (inputSize - imageSize.width * (inputSize / imageSize.height)) / 2,
    padY: imageSize.height >= imageSize.width ? 0 : (inputSize - imageSize.height * (inputSize / imageSize.width)) / 2,
    inputSize,
    sourceWidth: imageSize.width,
    sourceHeight: imageSize.height,
  };
}

function channelsForPngColorType(colorType) {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error(`ONNX adapter unsupported PNG color type ${colorType}`);
}

function unfilterPngRow(row, previous, bytesPerPixel, filter) {
  if (filter === 0) return;
  for (let index = 0; index < row.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const up = previous[index] ?? 0;
    const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;
    if (filter === 1) {
      row[index] = (row[index] + left) & 0xff;
    } else if (filter === 2) {
      row[index] = (row[index] + up) & 0xff;
    } else if (filter === 3) {
      row[index] = (row[index] + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      row[index] = (row[index] + paethPredictor(left, up, upperLeft)) & 0xff;
    } else {
      throw new Error(`ONNX adapter unsupported PNG row filter ${filter}`);
    }
  }
}

function paethPredictor(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function writeRgbaRow(row, rgba, y, width, colorType) {
  for (let x = 0; x < width; x += 1) {
    const target = (y * width + x) * 4;
    if (colorType === 0) {
      const gray = row[x];
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = 255;
    } else if (colorType === 2) {
      const source = x * 3;
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = 255;
    } else if (colorType === 4) {
      const source = x * 2;
      const gray = row[source];
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = row[source + 1];
    } else if (colorType === 6) {
      const source = x * 4;
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = row[source + 3];
    }
  }
}

function bestClass(extraction, rowIndex, startAttrIndex) {
  let bestIndex = 0;
  let bestScore = 0;
  for (let attrIndex = startAttrIndex; attrIndex < extraction.rowLength; attrIndex += 1) {
    const score = numberOrDefault(rowValue(extraction, rowIndex, attrIndex), 0);
    if (score > bestScore) {
      bestIndex = attrIndex - startAttrIndex;
      bestScore = score;
    }
  }
  return { index: bestIndex, score: bestScore };
}

function labelForClass(classIndex, labelMap) {
  if (Array.isArray(labelMap) && typeof labelMap[classIndex] === "string") {
    return labelMap[classIndex];
  }
  if (labelMap && typeof labelMap === "object" && typeof labelMap[classIndex] === "string") {
    return labelMap[classIndex];
  }
  return `class_${classIndex}`;
}

function numberOrDefault(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeConfidenceThreshold(value) {
  const threshold = numberOrDefault(value, DEFAULT_CONFIDENCE_THRESHOLD);
  return threshold >= 0 && threshold <= 1 ? threshold : DEFAULT_CONFIDENCE_THRESHOLD;
}

function normalizeInputSize(value) {
  return Math.min(MAX_INPUT_SIZE, Math.max(1, Math.trunc(numberOrDefault(value, DEFAULT_INPUT_SIZE))));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, numberOrDefault(value, min)));
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatDims(dims) {
  return `[${dims.map((dim) => Number.isFinite(dim) ? String(dim) : "NaN").join(",")}]`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
