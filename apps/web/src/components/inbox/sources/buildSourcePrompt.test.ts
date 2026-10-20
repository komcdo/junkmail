// @effect-diagnostics nodeBuiltinImport:off - quoting is checked against a real shell.
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it } from "vite-plus/test";

import { renderBuildSourcePrompt, shellQuote, sourceFolderName } from "./buildSourcePrompt";

describe("sourceFolderName", () => {
  it("slugs the name and keeps the random suffix", () => {
    expect(sourceFolderName("Jira: my tickets!", "a1b2c3")).toBe("jira-my-tickets-a1b2c3");
  });

  it("falls back when the name has nothing usable", () => {
    expect(sourceFolderName("✨✨", "a1b2c3")).toBe("source-a1b2c3");
  });
});

describe("shellQuote", () => {
  it("survives a real shell with spaces and quotes in the path", () => {
    const path = '/tmp/it\'s a "scratch" $HOME/pull';
    const echoed = NodeChildProcess.execFileSync(
      "/bin/sh",
      ["-c", `printf '%s' ${shellQuote(path)}`],
      {
        encoding: "utf8",
      },
    );
    expect(echoed).toBe(path);
  });
});

describe("renderBuildSourcePrompt", () => {
  it("names the script, the request and a Keychain entry safe to paste", () => {
    const prompt = renderBuildSourcePrompt({
      description: "Tickets assigned to me.",
      sourceName: 'My "Jira"',
      folder: "/scratch/inbox-sources/my-jira-a1b2c3",
      script: "/scratch/inbox-sources/my-jira-a1b2c3/pull",
      intervalMinutes: 10,
      timeoutSeconds: 120,
    });
    expect(prompt).toContain("Tickets assigned to me.");
    expect(prompt).toContain("`/scratch/inbox-sources/my-jira-a1b2c3/pull`");
    expect(prompt).toContain("-s junkmail-my-jira-a1b2c3 -a");
  });
});
