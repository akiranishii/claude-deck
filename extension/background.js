// Claude Deck Link Capture — background service worker.
//
// Privacy: this extension has host access only to https://claude.ai/code/* (plus the local
// Claude Deck bridge on 127.0.0.1). It only looks at tab URLs and, optionally, tab titles.
// It has no content scripts, so it cannot read conversation content, cookies or tokens.

const SESSION_RE = /^https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]{8,64})(?:[/?#]|$)/
const lastSent = new Map() // tabId -> "sessionId|title"

async function settings() {
  return chrome.storage.local.get({ token: null, port: null, enabled: true, sendTitles: true })
}

async function report(tabId, sessionId, title) {
  const s = await settings()
  if (!s.enabled || !s.token || !s.port) return
  const sentTitle = s.sendTitles ? title || null : null
  const key = `${sessionId}|${sentTitle ?? ''}`
  if (lastSent.get(tabId) === key) return
  lastSent.set(tabId, key)
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/visit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ url: `https://claude.ai/code/${sessionId}`, title: sentTitle }),
    })
    await chrome.storage.local.set(res.ok ? { lastSent: { sessionId, at: Date.now() }, lastError: null } : { lastError: `Claude Deck answered ${res.status}` })
  } catch (err) {
    lastSent.delete(tabId)
    await chrome.storage.local.set({ lastError: 'Claude Deck is not running or the bridge is disabled' })
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // tab.url / tab.title are only visible for claude.ai/code tabs thanks to the narrow host permission.
  const url = changeInfo.url || tab.url
  if (!url || !(changeInfo.url || changeInfo.title || changeInfo.status === 'complete')) return
  const m = SESSION_RE.exec(url)
  if (m) void report(tabId, m[1], tab.title)
})

chrome.tabs.onRemoved.addListener((tabId) => lastSent.delete(tabId))
