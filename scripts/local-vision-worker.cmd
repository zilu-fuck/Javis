@echo off
setlocal
if not "%JAVIS_LOCAL_VISION_NODE_PATH%"=="" (
  "%JAVIS_LOCAL_VISION_NODE_PATH%" "%~dp0local-vision-worker.mjs" %*
) else (
  node "%~dp0local-vision-worker.mjs" %*
)
