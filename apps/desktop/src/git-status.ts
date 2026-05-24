export function parseGitStatusFiles(output: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    const file = parseGitStatusLine(line);
    if (!file || seen.has(file)) {
      continue;
    }
    seen.add(file);
    files.push(file);
  }

  return files;
}

function parseGitStatusLine(line: string): string | undefined {
  if (line.trim().length < 4) {
    return undefined;
  }

  const status = line.slice(0, 2);
  const pathText = line.slice(3).trim();
  if (!pathText) {
    return undefined;
  }

  if (status.includes("R") || status.includes("C")) {
    return parseRenameTarget(pathText);
  }

  return unquoteGitPath(pathText);
}

function parseRenameTarget(pathText: string): string {
  const arrowIndex = pathText.lastIndexOf(" -> ");
  if (arrowIndex === -1) {
    return unquoteGitPath(pathText);
  }
  return unquoteGitPath(pathText.slice(arrowIndex + 4));
}

function unquoteGitPath(pathText: string): string {
  const trimmed = pathText.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return trimmed;
}
