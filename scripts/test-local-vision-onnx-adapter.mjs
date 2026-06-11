#!/usr/bin/env node

import { deflateSync } from "node:zlib";
import {
  decodePng,
  decodeYoloOutput,
  decodeYoloOutputWithDiagnostics,
  detect,
  letterboxToNchwTensor,
} from "./local-vision-onnx-adapter.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  const png = decodePng(createRgbaPng(2, 1, [
    255, 0, 0, 255,
    0, 255, 0, 255,
  ]));
  assert(png.width === 2, "PNG width mismatch");
  assert(png.height === 1, "PNG height mismatch");
  assert(png.rgba[0] === 255, "PNG red channel mismatch");
  assert(png.rgba[5] === 255, "PNG green channel mismatch");

  const preprocessed = letterboxToNchwTensor(png, 4);
  assert(preprocessed.transform.scale === 2, "letterbox scale mismatch");
  assert(preprocessed.transform.padX === 0, "letterbox padX mismatch");
  assert(preprocessed.transform.padY === 1, "letterbox padY mismatch");
  assert(closeTo(preprocessed.data[0], 114 / 255), "letterbox padding mismatch");
  assert(closeTo(preprocessed.data[4], 1), "letterbox red channel mismatch");
  assert(closeTo(preprocessed.data[16 + 6], 1), "letterbox green channel mismatch");

  const standardOutput = {
    dims: [1, 2, 7],
    data: new Float32Array([
      50, 60, 20, 10, 0.9, 0.1, 0.8,
      20, 20, 10, 10, 0.4, 0.9, 0.1,
    ]),
  };
  const detections = decodeYoloOutput(standardOutput, { width: 640, height: 640 }, {
    inputSize: 640,
    minConfidence: 0.5,
    labelMap: ["input", "button"],
  });
  assert(detections.length === 1, "standard output should filter low confidence rows");
  assert(detections[0].label === "button", "standard output label mismatch");
  assert(closeTo(detections[0].confidence, 0.72), "standard output confidence mismatch");
  assert(detections[0].box.x === 40, "standard output box x mismatch");
  assert(detections[0].box.y === 55, "standard output box y mismatch");

  const decodedWithDiagnostics = decodeYoloOutputWithDiagnostics(standardOutput, { width: 640, height: 640 }, {
    inputSize: 640,
    minConfidence: 0.5,
    labelMap: ["input", "button"],
  });
  assert(decodedWithDiagnostics.rawDetections.length === 1, "diagnostic decode detection mismatch");
  assert(decodedWithDiagnostics.diagnostics.outputLayout === "row_major", "diagnostic output layout mismatch");
  assert(decodedWithDiagnostics.diagnostics.rawRowCount === 2, "diagnostic row count mismatch");
  assert(decodedWithDiagnostics.diagnostics.filteredCount === 1, "diagnostic filtered count mismatch");

  const invalidConfidenceDiagnostics = decodeYoloOutputWithDiagnostics(standardOutput, { width: 640, height: 640 }, {
    inputSize: 640,
    minConfidence: -1,
    labelMap: ["input", "button"],
  });
  assert(invalidConfidenceDiagnostics.diagnostics.minConfidence === 0.25, "invalid min confidence should fall back to adapter default");
  assert(invalidConfidenceDiagnostics.rawDetections.length === 2, "invalid min confidence should not disable confidence filtering");

  const cappedInputDiagnostics = decodeYoloOutputWithDiagnostics(standardOutput, { width: 640, height: 640 }, {
    inputSize: 9999,
    minConfidence: 0.5,
    labelMap: ["input", "button"],
  });
  assert(cappedInputDiagnostics.diagnostics.inputSize === 1280, "decode diagnostics should cap input size");

  try {
    decodeYoloOutput({ dims: [1, 2, 3, 4], data: new Float32Array(24) }, { width: 640, height: 640 });
    throw new Error("unsupported output tensor shape should throw");
  } catch (error) {
    assert(
      String(error).includes("unsupported YOLO output tensor shape dims=[1,2,3,4]"),
      `unsupported shape error mismatch: ${error}`,
    );
  }

  try {
    decodeYoloOutput({ dims: [1, 100001, 5], data: new Float32Array(100001 * 5) }, { width: 640, height: 640 });
    throw new Error("oversized row-major output should throw");
  } catch (error) {
    assert(
      String(error).includes("too many candidate rows"),
      `oversized row-major output error mismatch: ${error}`,
    );
  }

  try {
    decodeYoloOutput({ dims: [1, 5, 100001], data: new Float32Array(100001 * 5) }, { width: 640, height: 640 });
    throw new Error("oversized channel-major output should throw");
  } catch (error) {
    assert(
      String(error).includes("too many candidate rows"),
      `oversized channel-major output error mismatch: ${error}`,
    );
  }

  try {
    decodeYoloOutput({ dims: [1, 800001, 5], data: { length: 4_000_001 } }, { width: 640, height: 640 });
    throw new Error("oversized tensor output should throw");
  } catch (error) {
    assert(
      String(error).includes("output tensor is too large"),
      `oversized tensor output error mismatch: ${error}`,
    );
  }

  try {
    decodePng(createRgbaPngHeaderOnly(20000, 20000));
    throw new Error("oversized PNG should throw before image allocation");
  } catch (error) {
    assert(
      String(error).includes("PNG exceeds"),
      `oversized PNG error mismatch: ${error}`,
    );
  }

  const letterboxedOutput = {
    dims: [1, 1, 5],
    data: new Float32Array([2, 2, 4, 2, 0.9]),
  };
  const letterboxedDetections = decodeYoloOutput(letterboxedOutput, { width: 2, height: 1 }, {
    inputSize: 4,
    minConfidence: 0.5,
    transform: preprocessed.transform,
  });
  assert(letterboxedDetections.length === 1, "letterboxed output should decode");
  assert(letterboxedDetections[0].box.x === 0, "letterboxed x should unpad");
  assert(letterboxedDetections[0].box.y === 0, "letterboxed y should unpad");
  assert(letterboxedDetections[0].box.width === 2, "letterboxed width should unscale");
  assert(letterboxedDetections[0].box.height === 1, "letterboxed height should unscale");

  const transposedOutput = {
    dims: [1, 6, 2],
    data: new Float32Array([
      50, 20,
      60, 20,
      20, 10,
      10, 10,
      0.9, 0.2,
      0.8, 0.9,
    ]),
  };
  const transposedDetections = decodeYoloOutput(transposedOutput, { width: 320, height: 320 }, {
    inputSize: 640,
    minConfidence: 0.5,
    labelMap: ["possible_button"],
  });
  assert(transposedDetections.length === 1, "transposed output should decode candidates");
  assert(transposedDetections[0].label === "possible_button", "transposed label mismatch");
  assert(transposedDetections[0].box.x === 20, "transposed scaled x mismatch");
  assert(transposedDetections[0].box.y === 27.5, "transposed scaled y mismatch");

  const rowMajorClassScoresOutput = {
    dims: [1, 2, 6],
    data: new Float32Array([
      80, 90, 20, 10, 0.1, 0.8,
      20, 20, 10, 10, 0.4, 0.1,
    ]),
  };
  const rowMajorClassScoreDetections = decodeYoloOutput(rowMajorClassScoresOutput, { width: 640, height: 640 }, {
    inputSize: 640,
    minConfidence: 0.5,
    labelMap: ["input", "button"],
  });
  assert(rowMajorClassScoreDetections.length === 1, "row-major class-score output should decode");
  assert(rowMajorClassScoreDetections[0].label === "button", "row-major class-score label mismatch");
  assert(closeTo(rowMajorClassScoreDetections[0].confidence, 0.8), "row-major class-score confidence mismatch");
  assert(rowMajorClassScoreDetections[0].box.x === 70, "row-major class-score x mismatch");

  const yoloV8LikeTransposedOutput = {
    dims: [1, 6, 2],
    data: new Float32Array([
      80, 20,
      90, 20,
      20, 10,
      10, 10,
      0.1, 0.4,
      0.8, 0.1,
    ]),
  };
  const yoloV8LikeTransposedDetections = decodeYoloOutput(yoloV8LikeTransposedOutput, { width: 640, height: 640 }, {
    inputSize: 640,
    minConfidence: 0.5,
    labelMap: ["input", "button"],
  });
  assert(yoloV8LikeTransposedDetections.length === 1, "YOLOv8-like transposed output should decode");
  assert(yoloV8LikeTransposedDetections[0].label === "button", "YOLOv8-like transposed label mismatch");
  assert(closeTo(yoloV8LikeTransposedDetections[0].confidence, 0.8), "YOLOv8-like transposed confidence mismatch");

  const yolo26LikeUiOutput = {
    dims: [1, 16, 1],
    data: new Float32Array([
      320, 320, 40, 20,
      0.1, 0.2, 0.3, 0.4,
      0.5, 0.91, 0.1, 0.2,
      0.3, 0.4, 0.5, 0.6,
    ]),
  };
  const yolo26LikeUiDetections = decodeYoloOutputWithDiagnostics(yolo26LikeUiOutput, { width: 640, height: 640 }, {
    inputSize: 640,
    minConfidence: 0.75,
  });
  assert(yolo26LikeUiDetections.rawDetections.length === 1, "YOLO26-like UI output should decode class scores without a label map");
  assert(yolo26LikeUiDetections.diagnostics.outputLayout === "channel_major", "YOLO26-like UI layout mismatch");
  assert(yolo26LikeUiDetections.rawDetections[0].label === "class_5", "YOLO26-like UI class label mismatch");
  assert(closeTo(yolo26LikeUiDetections.rawDetections[0].confidence, 0.91), "YOLO26-like UI confidence mismatch");

  const dir = await mkdtemp(join(tmpdir(), "javis-onnx-adapter-test-"));
  try {
    const imagePath = join(dir, "screen.png");
    const modelPath = join(dir, "model.onnx");
    await writeFile(imagePath, createRgbaPng(2, 1, [
      255, 0, 0, 255,
      0, 255, 0, 255,
    ]));
    await writeFile(modelPath, "placeholder model");
    const fakeRuntime = createFakeRuntime();
    const result = await detect({
      request: {
        imagePath,
        modelPath,
        imgsz: 4,
        minConfidence: 0.5,
        labelMap: ["possible_button"],
      },
      imageSize: { width: 2, height: 1 },
      runtime: fakeRuntime,
    });
    assert(result.runtime === "onnxruntime", "detect runtime mismatch");
    assert(result.rawDetections.length === 1, "detect should return decoded raw detections");
    assert(result.diagnostics.inputName === "images", "detect diagnostic input name mismatch");
    assert(JSON.stringify(result.diagnostics.inputDims) === JSON.stringify([1, 3, 4, 4]), "detect diagnostic input dims mismatch");
    assert(result.diagnostics.requestedInputSize === 4, "detect diagnostic requested input size mismatch");
    assert(result.diagnostics.inputSizeSource === "model", "detect should use fixed model input size");
    assert(result.diagnostics.outputName === "output0", "detect diagnostic output name mismatch");
    assert(JSON.stringify(result.diagnostics.outputDims) === JSON.stringify([1, 1, 5]), "detect diagnostic output dims mismatch");
    assert(result.rawDetections[0].label === "possible_button", "detect label mismatch");
    assert(result.rawDetections[0].box.x === 0, "detect box x mismatch");
    assert(result.rawDetections[0].box.y === 0, "detect box y mismatch");
    assert(result.rawDetections[0].box.width === 2, "detect box width mismatch");
    assert(result.rawDetections[0].box.height === 1, "detect box height mismatch");

    const cachedRuntime = createFakeRuntime();
    const firstCached = await detect({
      request: {
        imagePath,
        modelPath,
        imgsz: 4,
        minConfidence: 0.5,
      },
      imageSize: { width: 2, height: 1 },
      runtime: cachedRuntime,
    });
    const secondCached = await detect({
      request: {
        imagePath,
        modelPath,
        imgsz: 4,
        minConfidence: 0.5,
      },
      imageSize: { width: 2, height: 1 },
      runtime: cachedRuntime,
    });
    assert(cachedRuntime.createCount === 1, "detect should reuse ONNX sessions for the same runtime and model");
    assert(firstCached.diagnostics.sessionCacheHit === false, "first detect should report session cache miss");
    assert(secondCached.diagnostics.sessionCacheHit === true, "second detect should report session cache hit");

    const cappedInputRuntime = createFakeRuntime({ expectedDims: [1, 3, 4, 4] });
    const cappedInputResult = await detect({
      request: {
        imagePath,
        modelPath,
        imgsz: 9999,
        minConfidence: 0.5,
      },
      imageSize: { width: 2, height: 1 },
      runtime: cappedInputRuntime,
    });
    assert(JSON.stringify(cappedInputResult.diagnostics.inputDims) === JSON.stringify([1, 3, 4, 4]), "detect should use fixed model input shape when request imgsz differs");
    assert(cappedInputResult.diagnostics.requestedInputSize === 1280, "detect should record capped requested input size");
    assert(cappedInputResult.diagnostics.inputSizeSource === "model", "detect should report model input size source");

    const dynamicInputRuntime = createFakeRuntime({ expectedDims: [1, 3, 1280, 1280], inputMetadata: [] });
    const dynamicInputResult = await detect({
      request: {
        imagePath,
        modelPath,
        imgsz: 9999,
        minConfidence: 0.5,
      },
      imageSize: { width: 2, height: 1 },
      runtime: dynamicInputRuntime,
    });
    assert(JSON.stringify(dynamicInputResult.diagnostics.inputDims) === JSON.stringify([1, 3, 1280, 1280]), "dynamic model should use capped request imgsz");
    assert(dynamicInputResult.diagnostics.inputSizeSource === "request", "dynamic model should report request input size source");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  process.stdout.write("local vision ONNX adapter decode test passed\n");
}

function createFakeRuntime(options = {}) {
  const expectedDims = options.expectedDims ?? [1, 3, 4, 4];
  const inputMetadata = options.inputMetadata ?? [{ name: "images", shape: expectedDims }];
  let createCount = 0;
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  return {
    get createCount() {
      return createCount;
    },
    Tensor,
    InferenceSession: {
      async create(modelPath) {
        createCount += 1;
        assert(modelPath.endsWith("model.onnx"), "fake session model path mismatch");
        return {
          inputNames: ["images"],
          outputNames: ["output0"],
          inputMetadata,
          async run(feeds) {
            const tensor = feeds.images;
            assert(tensor.type === "float32", "fake tensor type mismatch");
            assert(JSON.stringify(tensor.dims) === JSON.stringify(expectedDims), "fake tensor dims mismatch");
            if (expectedDims[2] === 4) {
              assert(closeTo(tensor.data[0], 114 / 255), "fake tensor padding mismatch");
              assert(closeTo(tensor.data[4], 1), "fake tensor red channel mismatch");
            }
            return {
              output0: {
                dims: [1, 1, 5],
                data: new Float32Array([2, 2, 4, 2, 0.9]),
              },
            };
          },
        };
      },
    },
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function closeTo(value, expected) {
  return Math.abs(value - expected) < 0.0001;
}

function createRgbaPng(width, height, rgba) {
  const rowLength = width * 4;
  const raw = Buffer.alloc(height * (1 + rowLength));
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (1 + rowLength);
    raw[rowOffset] = 0;
    Buffer.from(rgba.slice(y * rowLength, y * rowLength + rowLength)).copy(raw, rowOffset + 1);
  }
  const chunks = [
    createChunk("IHDR", createIhdr(width, height)),
    createChunk("IDAT", deflateSync(raw)),
    createChunk("IEND", Buffer.alloc(0)),
  ];
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    ...chunks,
  ]);
}

function createRgbaPngHeaderOnly(width, height) {
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    createChunk("IHDR", createIhdr(width, height)),
    createChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createIhdr(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return ihdr;
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([
    length,
    typeBuffer,
    data,
    Buffer.alloc(4),
  ]);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
