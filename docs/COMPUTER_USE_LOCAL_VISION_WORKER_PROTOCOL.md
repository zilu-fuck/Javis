# Computer Use Local Vision Worker Protocol

This document describes the local vision worker protocol used by the Computer Use refactor.

The worker is optional. Computer Use must continue through UIA, screenshots, OCR/VLM fallback, and model planning when the worker is missing, slow, or broken.

## Runtime Configuration

Desktop local vision is disabled by default.

To enable it for experiments, write this JSON to localStorage key:

```text
javis.computerUse.localVision.v1
```

Example:

```json
{
  "localVision": {
    "enabled": true,
    "mode": "prompt_hint",
    "modelPath": "models/local-vision/yolo26n-ui.onnx",
    "runtime": "auto",
    "reuseWorker": true,
    "imgsz": 640,
    "timeoutMs": 120,
    "maxDetections": 20,
    "promptTopK": 8,
    "minConfidence": 0.75,
    "iouThreshold": 0.45,
    "disableAfterConsecutiveTimeouts": 2,
    "disableAfterConsecutiveErrors": 2
  }
}
```

Supported modes:

```text
passive      Run detection and trace results, without prompt hints.
prompt_hint  Add fused Top-K LOCAL_UI_CANDIDATES with local vision evidence to the model prompt.
```

Unsupported or unsafe modes are treated as disabled. Click assist is not enabled by this protocol.

`promptTopK` accepts `0`. In that configuration, detection still runs and step trace can record detection counts, latency, diagnostics, and runtime state, but `LOCAL_UI_CANDIDATES` is omitted from the prompt.

The Computer Use loop may lower the effective `imgsz` to `512` for the rest of the current task when repeated detections are close to the observation wait budget. This dynamic downgrade is a caller-side performance guard: it is recorded in trace, does not modify stored user settings, and does not change action authorization. Fixed-input ONNX models still use the model metadata input size, so an export fixed at `[1,3,640,640]` continues to run at 640 even if the caller requests 512.

## Worker Process

The Rust command `computer_detect_ui_objects` starts a worker only when both conditions are true:

```text
request.modelPath is non-empty
JAVIS_LOCAL_VISION_WORKER_PATH is set, or a bundled/dev worker script can be found
```

If either is missing, the command returns an empty detection result with an error summary where appropriate. It does not fail the Computer Use loop.

The worker path override is read from:

```text
JAVIS_LOCAL_VISION_WORKER_PATH
```

When the selected worker is an `.mjs` script, Rust starts it through Node.js. Node can be overridden with:

```text
JAVIS_LOCAL_VISION_NODE_PATH
```

If the override is missing, the desktop command searches for a bundled Node runtime before falling back to `PATH`. Lookup order is:

1. `JAVIS_LOCAL_VISION_NODE_PATH`
2. Packaged/dev candidates near the executable, executable `resources` directory, or current working directory ancestors:
   - `bin/node/node.exe`, `bin/node.exe`, `node/node.exe` on Windows
   - `bin/node/node`, `bin/node`, `node/node` on non-Windows platforms
3. `node` from `PATH`

If `JAVIS_LOCAL_VISION_NODE_PATH` is set but does not point to a file, desktop startup reports that override error and does not silently fall back to another Node. A bad explicit override should be fixed by the user or installer instead of being masked by PATH.

The repository `local-vision-worker.cmd` also honors `JAVIS_LOCAL_VISION_NODE_PATH` before falling back to `node` on `PATH`.

Desktop local vision is still disabled by default, but once the user explicitly enables `passive` or `prompt_hint` mode, worker reuse defaults to on. It can be disabled from the Computer Use local vision settings for diagnostics. Real-model latency experiments can also force worker reuse with:

```text
JAVIS_LOCAL_VISION_REUSE_WORKER=1
```

When enabled, Rust starts the worker with `--server`, sends each short-lived request JSON path over stdin, and reads one JSON response line from stdout. Any timeout, stdout error, process exit, or worker-path change kills and discards the reusable worker so the next request starts cleanly. Request JSON and screenshot PNG files remain short-lived and are still removed after each request. `reuseWorker` is a desktop startup strategy only; it is not forwarded into the worker request JSON.

When the override is not set, the desktop command searches for the repository-provided worker near the current executable, near an executable `resources` directory, and in parent directories of the current working directory. The packaged app bundles the worker and ONNX adapter resources under:

```text
scripts/local-vision-worker.cmd
scripts/local-vision-worker.mjs
scripts/local-vision-onnx-adapter.mjs
```

Automatic desktop worker discovery prefers `scripts/local-vision-worker.mjs` before the `.cmd` wrapper so Rust can apply the same Node lookup order for packaged and development builds. The `.cmd` wrapper remains bundled for manual Windows use and compatibility, but it only knows `JAVIS_LOCAL_VISION_NODE_PATH` and PATH fallback.

Because the current worker is JavaScript, packaged desktop startup also needs a Node runtime. `JAVIS_LOCAL_VISION_NODE_PATH` can point to a known Node executable; otherwise startup tries the bundled locations above and then falls back to `node` on PATH. If neither a bundled Node runtime nor PATH Node is available on the user's machine, local vision must degrade cleanly instead of blocking Computer Use.

Before building a release package, prepare the bundled Node runtime resource:

```bash
corepack pnpm local-vision:prepare-node
```

This copies the current Node executable into `artifacts/local-vision/node-runtime/`, which Tauri bundles as `bin/node/`. The signed release script runs the prepare step before the bundled-only doctor check.

Tauri `beforeBuildCommand` uses `corepack pnpm build:bundle`, which runs the prepare step before frontend build. The root `desktop:build` script runs the same prepare step before invoking `tauri build`, so direct packaged builds and signed release builds use the same bundled Node resource.

Repository-provided protocol worker:

```text
scripts/local-vision-worker.cmd
scripts/local-vision-worker.mjs
scripts/local-vision-onnx-adapter.mjs
```

The bundled worker validates the protocol and image file. For real inference requests it also validates that `modelPath` exists and is a file. With `runtime: "auto"` or `runtime: "onnxruntime"`, the default ONNX adapter can run YOLO-style ONNX models through `onnxruntime-node`; unsupported runtimes, missing native packages, missing model files, or unsupported output tensors return empty detections with explanatory errors. It deliberately does not fake UI detections.

For runtime integration tests, the worker also accepts `rawDetections` in the request JSON and converts them into protocol detections with confidence filtering, box clamping, NMS, and `maxDetections` limiting. This is the same adapter layer that ONNX/OpenVINO/TensorRT inference outputs should feed.

Runtime adapter experiments can be wired without changing the desktop process by setting:

```text
JAVIS_LOCAL_VISION_RUNTIME_ADAPTER=<adapter-module-path-or-package>
```

The adapter module must export `detect()` or a default function. It receives `{ request, imageSize }` and must return either an array of raw detections or `{ rawDetections: [...] }`. Before invoking the adapter, the protocol worker normalizes adapter-facing inference parameters: `imgsz` is capped at `1280`, `maxDetections` is capped at `100`, invalid confidence or IoU thresholds fall back to worker defaults, and timeout is clamped to `[20, 2000]` ms. The protocol worker still performs confidence filtering, box clamping, NMS, and result shaping. The adapter must not execute UI actions or return semantic authorization.

When `runtime` is `auto` or `onnxruntime` and no explicit adapter is configured, the protocol worker uses `scripts/local-vision-onnx-adapter.mjs` by default.

The repository-provided ONNX adapter is an experimental runtime skeleton. It dynamically loads `onnxruntime-node`, creates an inference session, decodes PNG screenshots, builds a YOLO-style letterboxed NCHW float tensor, and decodes common YOLO-style output tensors into raw detections. It supports row-major and channel-major YOLO outputs such as `[1, N, attrs]` and `[1, attrs, N]`, including both objectness layouts (`cx, cy, w, h, objectness, class...`) and common YOLOv8-style class-score layouts (`cx, cy, w, h, class...`). If the ONNX session metadata exposes a fixed square input shape, the adapter uses that model input size even when the request `imgsz` differs, and records `requestedInputSize` plus `inputSizeSource` diagnostics. This prevents dynamic caller-side `imgsz` downgrades from breaking fixed-shape exported models. Dynamic-shape models continue to use the normalized request `imgsz`. The root workspace declares `onnxruntime-node` as a dev dependency for local smoke and benchmark runs. If the package or native runtime cannot be loaded, the adapter fails fast with a clear error. Full production readiness still requires model-specific input/output validation and benchmark coverage for the chosen YOLO26 UI model.

Packaged desktop builds bundle the worker scripts plus `onnxruntime-node` and its runtime dependency `onnxruntime-common` under `scripts/node_modules/`, so the bundled adapter can resolve the native runtime from its own script directory instead of relying on the developer workspace `node_modules`.

The adapter tests cover PNG preprocessing, letterbox coordinate restoration, YOLO tensor decoding, and a fake ONNX session path. A real-model smoke test still requires a valid YOLO26 UI ONNX model file.

Doctor and self-test:

```text
pnpm local-vision:doctor
pnpm local-vision:doctor -- --image path/to/screen.png --model path/to/yolo26n-ui.onnx --runtime onnxruntime
pnpm local-vision:doctor -- --image path/to/screen.png --model path/to/yolo26n-ui.onnx --runtime onnxruntime --adapter path/to/yolo26-ui-adapter.mjs
```

The doctor command validates Node, the optional `JAVIS_LOCAL_VISION_NODE_PATH` override, whether packaged desktop startup has a Node runtime or must rely on PATH, worker scripts, a real worker `--self-test` launch, the ONNX adapter, `onnxruntime-node`, packaged `onnxruntime-node`/`onnxruntime-common` resource presence, and optional image/model/runtime-adapter paths. Its optional `--runtime` flag accepts only `auto`, `onnxruntime`, `openvino`, or `tensorrt`; unsupported runtime names fail explicitly. ONNX Runtime expects `.onnx`, OpenVINO expects `.xml` plus a sibling `.bin`, and TensorRT expects `.engine`. For ONNX models, doctor also inspects session metadata when `onnxruntime-node` can load the file, reporting input/output names, shapes, and fixed square input size when present. This lets fixed-shape exports such as `[1,3,640,640]` be identified before benchmark runs. If `--adapter` is provided, doctor checks that the runtime adapter path is readable and is a file, while reporting only the adapter filename. It exits with code `2` when a required check fails. A missing Node override is reported as a warning because bundled Node and PATH-based startup remain supported; an invalid override fails the worker self-test because desktop startup would fail too. Development or machine-prep checks can add `--require-desktop-node-runtime`, which accepts either `JAVIS_LOCAL_VISION_NODE_PATH` or bundled Node while upgrading PATH-only startup into a failure. Release checks should add `--require-bundled-desktop-node-runtime`, which fails unless Tauri bundle resources include Node and does not allow an environment override to mask a non-self-contained installer.

```text
pnpm local-vision-worker:test
```

Real-model smoke command:

```text
pnpm local-vision:smoke -- --image path/to/screen.png --model path/to/yolo26n-ui.onnx --iou-threshold 0.45 --min-detections 1
```

Run the doctor first when wiring a new model or machine. The smoke command defaults to `--runtime onnxruntime`, accepts only `auto`, `onnxruntime`, `openvino`, or `tensorrt`, and exits with code `2` when the worker returns a protocol-level error or `timedOut=true`, such as a missing native ONNX runtime, unsupported model output, or adapter-reported timeout. `--min-detections` is optional and defaults to `0`; use `--min-detections 1` for UI screenshots that should contain at least one detectable candidate. Smoke normalizes effective request parameters before writing the worker request JSON: invalid confidence or IoU thresholds fall back to the CLI defaults, `imgsz` is capped at `1280`, `maxDetections` is capped at the worker maximum, and timeout is clamped to the worker range. Worker process exits, polluted/non-JSON stdout, and bounded-output failures are also returned as structured JSON failure results instead of only stderr text, so real-model smoke runs remain machine-readable.

Real-model latency benchmark command:

```text
pnpm local-vision:benchmark -- --image path/to/screen.png --model path/to/yolo26n-ui.onnx --iterations 20 --warmup 1 --reuse-worker --max-p95-ms 150 --iou-threshold 0.45 --min-detections 1
```

The benchmark command defaults to `--runtime onnxruntime` and accepts only `auto`, `onnxruntime`, `openvino`, or `tensorrt`. It can reuse one worker process across warmup and measured iterations with `--reuse-worker`. This keeps ONNX sessions warm in-process and measures steady-state local vision latency instead of process startup and model-load cost. It prints a sanitized configuration snapshot, p50/p95/max latency, detection-count samples and summary stats, observed `runtimeCounts`, observed `modelCounts`, observed adapter input-size counts, error count, failure breakdown, and budget failures. The configuration snapshot records effective request values such as runtime, `imgsz`, thresholds, timeout, and the adapter filename only; it must not expose full local paths. Benchmark caps `imgsz` at `1280` before writing the worker request, matching the Computer Use loop guard. `inputSizeCounts`, `requestedInputSizeCounts`, and `inputSizeSourceCounts` summarize adapter diagnostics, so fixed-shape ONNX models that override a requested `imgsz` are visible in the report. It counts any worker `error`, `timedOut=true`, or sample below `--min-detections` as an error sample, and exits with code `2` when the configured p95 or error-count budget is exceeded. Worker crashes, non-JSON output, and stdout/stderr byte-limit failures are counted as error samples in the same JSON report instead of aborting the benchmark with an unstructured CLI error. `failureBreakdown` separates timeout, worker/adapter error, min-detection failure, zero-detection samples, and successful samples so real-model runs are easier to diagnose. `runtimeCounts` records the runtime selected by the worker result, so `--runtime auto` runs can confirm whether inference actually used ONNX Runtime, OpenVINO, TensorRT, or fell back to `unknown`.

Adapter-level async timeouts are best-effort because a synchronous CPU-bound adapter can block the worker event loop before its promise yields. The desktop Rust command, smoke command, and benchmark command therefore also enforce process-level timeouts and kill the worker process. This outer timeout is the required safety boundary for sync loops, native runtime hangs, and other non-yielding adapter failures.

## Request Delivery

The Rust side writes a short-lived PNG image file, then writes a short-lived JSON request file and starts the worker like this:

```text
<worker> <request-json-path>
```

It also sets:

```text
JAVIS_LOCAL_VISION_REQUEST_PATH=<request-json-path>
```

The request and image files are removed after the worker exits or times out. The Rust temp-file holder also cleans them up on drop, so startup errors, timeout paths, and future early returns do not leave screenshot PNG or request JSON files behind.

Request shape:

```ts
type ComputerDetectUiObjectsRequest = {
  imagePath: string
  screenshotId: string
  observationId?: string
  windowHandle?: number
  classes?: string[]
  modelPath?: string
  runtime?: "auto" | "onnxruntime" | "openvino" | "tensorrt"
  imgsz?: number
  maxDetections?: number
  minConfidence?: number
  iouThreshold?: number
  timeoutMs?: number
  runtimeAdapterPath?: string
  labelMap?: Record<string, string>
}
```

The worker request JSON does not include screenshot base64. The public TypeScript `ComputerTool.detectUiObjects` request accepts `imageDataUrl` and optional `reuseWorker`; Rust decodes the image into a short-lived `imagePath` before invoking the worker and uses `reuseWorker` only to choose single-shot versus `--server` startup. `imagePath` is worker-internal and must not be accepted by the public TypeScript request type.

`runtimeAdapterPath`, `iouThreshold`, and `labelMap` are optional local-model adapter fields. Desktop Computer Use remains disabled by default, but when local vision is explicitly enabled these fields are carried from storage/runtime config through the TypeScript loop, Rust, and the worker so model-specific adapters and NMS tuning can be tested without changing the Tauri command again.

`rawDetections` is a worker protocol test/debug field only, not part of the public TypeScript `ComputerTool.detectUiObjects` request type. The default Computer Use loop must not inject `rawDetections`; real detections should come from the worker adapter. Runtime integration tests may write `rawDetections` directly into the worker JSON request file. If a request or adapter output is marked `timedOut` or contains a non-empty `error`, raw detections must still be dropped.

The protocol worker rejects request JSON larger than 512 KiB, image files larger than 16 MiB, PNG dimensions above 16 million pixels, and adapter/debug `rawDetections` arrays above 20,000 items before expensive adaptation/NMS work. It also normalizes adapter-facing inference parameters before calling a runtime adapter, so direct worker JSON requests cannot pass unbounded `imgsz` or invalid thresholds to custom adapters. The ONNX adapter repeats the image size, input-size, and pixel checks so direct adapter smoke tests also fail before unbounded decode/allocation.

The worker must not log image paths together with user task content unless needed for debugging, and it must never log screenshot base64. Model and runtime-adapter paths must not be written verbatim to prompts, task history, audit records, or user-visible trace; result summaries should expose only a model filename or `unknown`.

Desktop `computer.inspectUi` may include optional UIA bounds in its text tree:

```text
<Button name="Save" automationId="saveButton" bounds="220,280,90,32">
```

The bounds are screen-coordinate rectangles from UI Automation. The TypeScript Computer Use loop maps them into the current screenshot coordinate system before using them to fuse UIA controls with local vision detections. These bounds are structural evidence only; they do not authorize actions and invalid or off-screenshot rectangles are ignored.

## Worker Response

The worker writes one JSON object to stdout:

```ts
type ComputerDetectUiObjectsResult = {
  screenshotId: string
  detections: ComputerUiDetection[]
  latencyMs: number
  model: string
  runtime: "onnxruntime" | "openvino" | "tensorrt" | "unknown"
  timedOut: boolean
  error?: string
  diagnostics?: Record<string, unknown>
}
```

`runtime: "auto"` is a request preference, not a result value. If no concrete runtime was selected, the result should report `runtime: "unknown"`.

`diagnostics` is optional and is only for smoke, benchmark, and trace inspection. The bundled worker sanitizes it by redacting image data URLs, truncating long strings, and limiting object/array depth. TypeScript may record the sanitized diagnostics in step trace, but it must not add diagnostics to `LOCAL_UI_CANDIDATES` or other model prompt text.

The TypeScript step trace may also record `reuseWorker: true` when the desktop loop requested reusable-worker startup for that observation. This is a local performance/debug signal only; it does not authorize actions and is not forwarded into `LOCAL_UI_CANDIDATES`.

Rust adds desktop-side diagnostics named `desktopWorkerMode` (`single_shot` or `reusable`) and `desktopWorkerReused` to each worker result when a worker process actually ran. These fields help confirm whether the reusable-worker path is taking effect without exposing local paths or screenshot data.

Detection shape:

```ts
type ComputerUiDetection = {
  id: string
  label: string
  confidence: number
  box: {
    x: number
    y: number
    width: number
    height: number
    coordinateSpace: "screenshot"
    screenshotSize?: { width: number; height: number }
    devicePixelRatio?: number
    monitorId?: string
    windowHandle?: number
  }
  center: {
    x: number
    y: number
    coordinateSpace: "screenshot"
  }
  source: "yolo26" | string
}
```

If `screenshotId` does not match the current request, Rust returns an empty stale-result error and the TypeScript loop also discards it.

## Timeout And Failure Rules

The worker is a hint source, not a required dependency.

Rules:

```text
1. Worker timeout returns empty detections with timedOut=true.
2. Worker stderr is truncated before being returned.
3. Invalid stdout JSON returns empty detections with an error.
4. Repeated TypeScript-side timeouts disable local vision for the current task.
5. Repeated detector errors with no detections disable local vision for the current task.
6. Screenshot/base64 data never enters worker JSON or long-term prompt history.
7. YOLO-only results are candidates, not semantic proof or high-risk action authorization.
8. UIA-only controls stay in `UIA CONTEXT`; they must not be duplicated into `LOCAL_UI_CANDIDATES` unless fused with local vision evidence.
9. Prompt Top-K is only a context budget. `promptTopK=0` disables prompt candidate insertion while preserving detection trace. Execution preflight must evaluate all current fused candidates that pass minConfidence filtering, so a high-risk candidate hidden from LOCAL_UI_CANDIDATES by Top-K truncation can still require fresh approval or block direct execution. Detections below minConfidence must not enter prompt hints or preflight blocking.
10. If `timedOut=true`, the TypeScript caller must treat detections as empty even if the worker response contains late or partial boxes. Timeout results can update diagnostics and timeout counters, but must not enter prompt hints or preflight.
11. If `error` is non-empty, worker/Rust/TypeScript must also treat detections as empty. A response cannot be both a failed inference and a trusted candidate source.
12. Local vision cannot grant or reuse Computer Use approval. Task-level approval reuse is limited to same-task, same-window, low-risk tools and is finally enforced by Rust/Tauri.
13. Non-sensitive selector-based `setUiValue` may use a task lease; `type`, `keyCombo`, sensitive `setUiValue`, and sensitive `invokeUi` still require fresh per-action approval.
14. Official Ultralytics YOLO26 COCO model names such as `yolo26n.onnx` or `yolo26n.pt` are trace-only in Computer Use. They may record latency, detection counts, and diagnostics for smoke/benchmark work, but they must not produce UI candidates, `LOCAL_UI_CANDIDATES`, auto-crops, preflight risk matches, or approval decisions. A UI-trained model such as `yolo26n-ui.onnx` is required before local detections can enter the UI candidate path.
```

Current implementation supports the process protocol and includes a runnable protocol worker with request validation, model-path readiness checks, raw detection adaptation, NMS, confidence filtering, timeout-safe Rust invocation, stale screenshot rejection, optional desktop worker reuse, benchmark worker reuse, and an experimental ONNX adapter with PNG preprocessing, YOLO output decoding, and same-process ONNX session caching. Production ONNX/OpenVINO/TensorRT inference is still a separate hardening step.

The experimental ONNX adapter reports small diagnostics such as input name, input dimensions, effective input size, requested input size, input-size source (`model` or `request`), output name, output dimensions, decoded row count, filtered count, and layout. It caps effective request input size at `1280` even when called directly, so direct adapter tests or custom runtime experiments cannot accidentally allocate an unbounded input tensor. Unsupported output tensor shapes fail explicitly instead of silently returning zero detections, so real-model smoke tests can distinguish "no UI candidate found" from "model output layout is unsupported."
