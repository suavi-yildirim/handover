// Sending episodes to the project, at no cost and with no server. The player downloads the
// episode file, then a new GitHub issue opens with the file to drag into it. The issue is
// public and stays in GitHub's history, so the consent step in the page must say so first.
// See docs/upload.md for the trade-offs and the other options considered.

// Repository that receives the issues. Change it if the project moves.
export const ISSUE_REPO = 'suavi-yildirim/handover';

// Address of a new issue on ISSUE_REPO, with the title and a body that tells the player what
// to do. The file itself can't be attached by URL, so the player drags it in.
export function issueUrl({ count, gameVersion, filename, repo = ISSUE_REPO }) {
  const title = `Episodes: ${count} from game ${gameVersion}`;
  const body = [
    `I'm sharing ${count} recorded episode${count === 1 ? '' : 's'} (game ${gameVersion}) under CC-BY-4.0.`,
    '',
    `**Attach the file here by dragging it into this box:** \`${filename}\``,
    '',
    'I understand that the file, including my random contributor ID, becomes public on GitHub ' +
      'and cannot be fully removed once posted.',
  ].join('\n');
  const q = new URLSearchParams({ title, body });
  return `https://github.com/${repo}/issues/new?${q}`;
}

// Opens the issue page in a new tab. Returns false when the browser blocked the tab, so the
// caller can show a direct link instead. (noopener is set by hand: with it, window.open always
// returns null, and blocking couldn't be detected.)
export function openIssue(url, win = globalThis.window) {
  const tab = win?.open?.(url, '_blank');
  if (!tab) return false;
  tab.opener = null;
  return true;
}
