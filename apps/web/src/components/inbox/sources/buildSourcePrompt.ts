/**
 * junkmail: the brief for an agent that builds a command source. junkmail only runs the script
 * the agent writes; the agent works out how to reach the system with whatever the machine has.
 */

/** Quotes `value` for a POSIX shell, the way the server runs source commands. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A folder name for the source's script: readable, and unique without asking the server. */
export function sourceFolderName(name: string, random: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "source"}-${random}`;
}

export function renderBuildSourcePrompt(input: {
  readonly description: string;
  readonly sourceName: string;
  readonly folder: string;
  readonly script: string;
  readonly intervalMinutes: number;
  readonly timeoutSeconds: number;
}): string {
  // The folder name is a slug, so it is safe unquoted in the Keychain command.
  const keychainService = `junkmail-${input.folder.split(/[\\/]/).pop() ?? "source"}`;
  return `Build an inbox source for junkmail, my AI-triaged work inbox. junkmail runs a script on a schedule and files every item the script prints into my inbox.

## What it should pull

${input.description}

## The script

Write an executable script at \`${input.script}\`, creating \`${input.folder}\` first. That folder belongs to this source, so keep any helper files or state there. Any language works if the script has a shebang and \`chmod +x\`. junkmail runs it every ${input.intervalMinutes} minutes through my login shell, so it sees the same PATH and signed-in CLIs as my terminal, but from an arbitrary working directory, so locate files relative to the script. It is stopped after ${input.timeoutSeconds} seconds.

Print one JSON object per line to stdout, nothing else:

\`\`\`json
{"key": "PROJ-123", "title": "Fix the login redirect", "url": "https://...", "priority": 2, "labels": ["jira"], "activity": [{"key": "comment-991", "body": "Can you take a look?", "author": "Dana", "occurredAt": "2026-01-02T15:04:05Z"}]}
\`\`\`

- \`key\` and \`title\` are required. \`key\` must name the same thing on every run: printing a key again updates that inbox item instead of filing a new one.
- \`activity\` is the conversation or event history. Each event needs a stable \`key\` and an ISO \`occurredAt\`; events junkmail has not seen before mark the item as having news. Include enough \`body\` text to triage from without opening the link.
- Optional: \`body\` (a short summary), \`url\`, \`priority\` (0 urgent to 4 none), \`labels\`, \`keepTitle\` (true keeps the item's existing title).
- Print only what needs my attention, such as things assigned to me, waiting on me, or mentioning me, not everything the system has.
- \`$JUNKMAIL_LAST_SUCCESS_AT\` holds the ISO time of the last successful run, empty on the first run. Use it to fetch only what changed, and look back a few days on the first run.
- On failure, print the reason to stderr and exit non-zero; junkmail shows that message and retries later. Printing nothing and exiting 0 means nothing is new.

## Credentials

Prefer a CLI that is already signed in on this machine, such as \`gh\`, \`glab\`, \`acli\` or \`gcloud\`. If the system needs a token, do not ask me to paste it here. Give me this command to run in my own terminal, which prompts for the token and stores it in the macOS Keychain: \`security add-generic-password -s ${keychainService} -a "$USER" -w\`. The script reads it at run time with \`security find-generic-password -s ${keychainService} -w\`. Never write a secret into the script or its folder.

## When you are done

Run the script once and summarize what it printed. Then tell me to open Settings > Inbox Sources, check "${input.sourceName}" with Preview, and turn on "Run automatically". junkmail is already set up to run \`${input.script}\`; do not change junkmail's settings or database yourself.`;
}
