export function isVisionGoal(userGoal: string): boolean {
  const goal = userGoal.trim();
  if (!goal) return false;
  if (inferImagePath(goal)) return true;
  return /\b(image|photo|picture|screenshot|ocr|vision)\b|图片|图像|照片|截图|看图/i.test(goal);
}

export function inferImagePath(userGoal: string): string | undefined {
  const dataUrl = userGoal.match(/data:image\/[a-z0-9.+-]+;base64,[^\s]+/i)?.[0];
  if (dataUrl) return dataUrl;
  const quoted = userGoal.match(/["'`]([^"'`]+\.(?:png|jpe?g|webp|gif|bmp|tiff?))["'`]/i)?.[1];
  if (quoted) return quoted.trim();
  return userGoal.match(/([A-Za-z]:[\\/][^\s"'`]+\.(?:png|jpe?g|webp|gif|bmp|tiff?)|(?:\.{1,2}[\\/])?[^\s"'`]+\.(?:png|jpe?g|webp|gif|bmp|tiff?))/i)?.[1]?.trim();
}

export function inferVisionMode(userGoal: string): "analyze" | "ocr" | "describe" {
  if (/ocr|text|文字|识别文字|提取.*字/i.test(userGoal)) return "ocr";
  if (/describe|describe.*image|描述.*图|描述.*照片|what.*see|tell me about/i.test(userGoal)) return "describe";
  return "analyze";
}
