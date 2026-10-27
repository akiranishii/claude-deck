# Claude Deck Link Capture (optional Chrome extension)

Records the exact `https://claude.ai/code/session_…` URL whenever you open a Claude Code conversation in a paired Chrome profile,
so Claude Deck can reopen it later — even for conversations started from claude.ai or the mobile app.

**Privacy:** host access is limited to `https://claude.ai/code/*` and the local Claude Deck bridge on `127.0.0.1`. There are no content
scripts: the extension sees tab URLs (and, if enabled, tab titles) only — never page content, cookies or tokens.

## Install (once per Chrome profile)

1. In Claude Deck: **Settings → Chrome extension** → enable the bridge.
2. In Chrome (in the profile you want to pair): open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select
   this `extension/` folder.
3. In Claude Deck, click **Pairing code** next to the account that uses this Chrome profile and copy the code (valid 10 minutes).
4. Click the extension’s toolbar icon in Chrome, paste the code, **Pair**.

Repeat for each profile/account. When you open a conversation on claude.ai/code that Claude Deck already knows, its title and
“last opened” time are updated (and you are warned if it was opened in another account’s profile). A conversation Claude Deck has not
seen yet is never attached automatically — it could be a cloud/web session rather than one served from your VM — so it goes to the
**Inbox** (dashboard banner), where you choose the session it belongs to or dismiss it.

To stop: untick **Capture conversation links**, click **Unpair**, or disable the bridge in Claude Deck.
