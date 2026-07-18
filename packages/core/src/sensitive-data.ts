const AUTHORIZATION_VALUE_PATTERN = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+\/=\-]{8,}/giu;
const LABELED_SECRET_PATTERN = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|authorization|token|secret|password|passwd|credential|credentials|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|cookie|set[_-]?cookie)\b(\s*[:=]\s*)(["']?)([^\s,;"']+)\3/giu;
const COMMON_SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|hf_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2})\b/gu;
const URL_CREDENTIAL_PATTERN = /:\/\/[^\s\/@:]+:[^\s\/@]+@/gu;

const SENSITIVE_FIELD_NAMES = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "authorization",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "clientsecret",
  "privatekey",
  "secretaccesskey",
  "cookie",
  "setcookie",
]);

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(name.toLowerCase().replace(/[^a-z0-9]/gu, ""));
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE_PATTERN, "$1 [redacted:secret]")
    .replace(LABELED_SECRET_PATTERN, "$1$2$3[redacted:secret]$3")
    .replace(COMMON_SECRET_PATTERN, "[redacted:secret]")
    .replace(URL_CREDENTIAL_PATTERN, "://[redacted:credentials]@");
}
