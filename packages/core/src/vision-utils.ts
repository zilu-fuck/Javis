export function isVisionGoal(userGoal: string): boolean {
  const goal = userGoal.trim();
  if (!goal) return false;
  if (inferImagePath(goal)) return true;
  return /\b(image|photo|picture|screenshot|ocr|vision)\b|图片|图像|照片|截图|看图/i.test(goal);
}

export function isImageContentAnalysisRequest(userGoal: string): boolean {
  const goal = userGoal.trim();
  if (!goal) return false;

  const concreteImage = inferImagePath(goal);
  const asksToCaptureScreen = /(?:截|拍|抓)(?:一|个|张|下)?.{0,3}(?:图|屏)|截图(?:一下|当前|桌面)|take (?:a )?screenshot|capture (?:the )?screen/i.test(goal);
  if (asksToCaptureScreen && !concreteImage) return false;

  const hasImageReference = Boolean(concreteImage) ||
    /\b(?:image|photo|picture|screenshot)\b|图片|图像|照片|这张图|这个图|上图|附图|截图/i.test(goal);
  if (!hasImageReference) return false;

  const refersToProvidedImage = Boolean(concreteImage) ||
    /这张|这幅|这个图|上图|附图|attached|provided/i.test(goal);
  const hasCodeSubject = /代码|组件|接口|功能|上传|渲染|bug|报错|实现|\b(?:code|component|api|upload|render|implementation)\b/i.test(goal);
  if (hasCodeSubject && !refersToProvidedImage) return false;

  return /\b(?:ocr|read|extract|recognize|transcribe|describe|analy[sz]e|identify)\b|看看|看下|看一看|识别|提取|写(?:的|了|着)?什么|什么内容|内容是什么|描述|分析|文字|字/i.test(goal);
}

export function inferImagePath(userGoal: string): string | undefined {
  const dataUrl = userGoal.match(/data:image\/[a-z0-9.+-]+;base64,[^\s]+/i)?.[0];
  if (dataUrl) return dataUrl;
  const quoted = userGoal.match(/["'`]([^"'`]+\.(?:png|jpe?g|webp|gif|bmp|tiff?))["'`]/i)?.[1];
  if (quoted) return quoted.trim();
  return userGoal.match(/([A-Za-z]:[\\/][^\s"'`]+\.(?:png|jpe?g|webp|gif|bmp|tiff?)|(?:\.{1,2}[\\/])?[^\s"'`]+\.(?:png|jpe?g|webp|gif|bmp|tiff?))/i)?.[1]?.trim();
}

export function inferVisionMode(userGoal: string): "analyze" | "ocr" | "describe" {
  if (/ocr|text|文字|识别.{0,4}(?:文字|字)|提取.{0,4}(?:文字|字)|写(?:的|了|着)?什么|上面.{0,4}(?:写|字)/i.test(userGoal)) return "ocr";
  if (/describe|describe.*image|描述.*图|描述.*照片|什么内容|内容是什么|图(?:里|中|上)有什么|是什么图|what.*see|what(?:'s| is).*(?:in|on).*(?:image|picture|photo)|tell me about/i.test(userGoal)) return "describe";
  return "analyze";
}
