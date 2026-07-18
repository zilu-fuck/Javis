interface BrowserLauncher<TBrowser> {
  launch(options: { headless: boolean; channel?: string }): Promise<TBrowser>;
}

type BrowserLaunchCandidate = {
  channel?: "msedge" | "chrome";
  label: string;
};

export function getBrowserLaunchCandidates(platform = process.platform): BrowserLaunchCandidate[] {
  if (platform === "win32") {
    return [
      { channel: "msedge", label: "Microsoft Edge" },
      { channel: "chrome", label: "Google Chrome" },
      { label: "Playwright Chromium" },
    ];
  }
  return [{ label: "Playwright Chromium" }];
}

export async function launchBrowser<TBrowser>(
  launcher: BrowserLauncher<TBrowser>,
  headless: boolean,
  platform = process.platform,
): Promise<TBrowser> {
  const failures: string[] = [];
  for (const candidate of getBrowserLaunchCandidates(platform)) {
    try {
      return await launcher.launch({
        headless,
        ...(candidate.channel ? { channel: candidate.channel } : {}),
      });
    } catch (error) {
      failures.push(`${candidate.label}: ${summarizeError(error)}`);
    }
  }
  throw new Error(`Unable to launch a browser. ${failures.join("; ")}`);
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().replace(/\s+/g, " ") || "Unknown launch error";
}
