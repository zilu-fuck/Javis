# Computer Use + MiMo + YOLO Live QA

- Date: 2026-06-16T17:38:10+08:00
- Result: PARTIAL PASS
- Model: mimo-v2.5
- Base URL: https://token-plan-cn.xiaomimimo.com/v1
- Local vision: yolo26n-ui.onnx via onnxruntime
- Goal: Run one Computer Use decision QA pass using a real screenshot, YOLO/localVision candidates, and MiMo multimodal reasoning. No desktop action was executed.

## Artifacts

- Screenshot: mimo-yolo-live-screen.png
- YOLO output: mimo-yolo-local-vision-smoke.json
- MiMo first summary: mimo-yolo-vlm-summary.json
- MiMo first raw response: mimo-yolo-vlm-response.json
- MiMo retry summary: mimo-yolo-vlm-summary-retry.json
- MiMo retry raw response: mimo-yolo-vlm-response-retry.json
- Evidence JSON: mimo-yolo-computer-use-live-evidence.json

## Checks

- Screenshot saved: PASS, 1920x1080 desktop capture.
- YOLO/localVision: PASS, 20 detections, latency 669ms, runtime $(@{screenshotId=smoke-1781602526688-mimo-yolo-live-screen.png; detections=System.Object[]; latencyMs=669; model=yolo26n-ui.onnx; runtime=onnxruntime; timedOut=False; diagnostics=; warnings=System.Object[]}.runtime).
- MiMo multimodal API: PASS, retry returned in 3975ms using image tokens 2040.
- MiMo semantic action: PASS, retry identified the Javis chat input and suggested a safe click action.
- Strict action JSON contract: FAIL, retry wrapped JSON in a Markdown fenced code block.

## Errors Recorded

1. First MiMo call returned empty content; it used 899 reasoning tokens and stopped by length. This shows max_tokens=900 is too small when reasoning is enabled.
2. Retry with 	hinking: { type: "disabled" } returned useful action content, but not strict JSON because it included `json fences.

## Notes

YOLO candidates were treated only as location hints. The proposed click was not executed, so this run validates perception and action selection, not desktop mutation.
