const $ = (id) => document.getElementById(id)

async function load() {
  return chrome.storage.local.get({ token: null, port: null, account: null, enabled: true, sendTitles: true, lastSent: null, lastError: null })
}

async function refresh() {
  const s = await load()
  $('enabled').checked = s.enabled
  $('titles').checked = s.sendTitles
  $('pairBox').style.display = s.token ? 'none' : 'grid'
  $('unpair').disabled = !s.token
  const status = $('status')
  if (!s.token) {
    status.textContent = 'Not paired yet.'
    status.className = 'status'
    return
  }
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/ping`, { headers: { Authorization: `Bearer ${s.token}` } })
    if (!res.ok) throw new Error(String(res.status))
    const body = await res.json()
    status.textContent = `Paired with Claude Deck as ${body.account ?? s.account ?? 'account'}.` + (s.lastSent ? ` Last link sent ${new Date(s.lastSent.at).toLocaleTimeString()}.` : '')
    status.className = 'status ok'
  } catch {
    status.textContent = s.lastError || 'Claude Deck is not reachable (is it running with the extension bridge enabled?).'
    status.className = 'status err'
  }
}

$('pair').addEventListener('click', async () => {
  const code = $('code').value.trim().toUpperCase()
  const m = /^CDECK-(\d{4,5})-([0-9A-F]{10})$/.exec(code)
  const status = $('status')
  if (!m) {
    status.textContent = 'That does not look like a Claude Deck pairing code.'
    status.className = 'status err'
    return
  }
  const port = Number(m[1])
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
    const body = await res.json()
    if (!res.ok || !body.token) throw new Error(body.error || `HTTP ${res.status}`)
    await chrome.storage.local.set({ token: body.token, port, account: body.account, lastError: null })
    $('code').value = ''
  } catch (err) {
    status.textContent = `Pairing failed: ${err.message}`
    status.className = 'status err'
    return
  }
  await refresh()
})

$('unpair').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token', 'port', 'account', 'lastSent', 'lastError'])
  await refresh()
})
$('enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }))
$('titles').addEventListener('change', (e) => chrome.storage.local.set({ sendTitles: e.target.checked }))

void refresh()
