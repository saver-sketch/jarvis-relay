// Jarvis relay: a tiny reverse tunnel. The Mac (cockpit/server.ts) dials OUT to /agent over a
// WebSocket; phones hit this service over HTTPS with a secret token and every request is
// forwarded to the Mac. No files, no state, one secret (RELAY_TOKEN).
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.PORT || 8795)
const TOKEN = process.env.RELAY_TOKEN
if (!TOKEN || TOKEN.length < 24) { console.error('RELAY_TOKEN missing'); process.exit(1) }

let agent = null                       // the Mac's socket
const pending = new Map()              // req id → {res, timer}
const phones = new Map()               // cid → phone ws
const PUBLIC = p => p === '/sw.js' || p.startsWith('/pwa/') || p === '/health'

function tokenOf(req, url) {
  const q = url.searchParams.get('k'); if (q) return q
  const m = /(?:^|;\s*)k=([^;]+)/.exec(req.headers.cookie || ''); return m ? m[1] : null
}
function safeEq(a, b) { if (!a || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0 }
function offline(res) { res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5' }); res.end('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Jarvis</title><body style="font-family:-apple-system,system-ui;background:#0b0f14;color:#e6edf3;display:grid;place-items:center;height:100dvh;margin:0"><div style="text-align:center"><div style="font-size:40px">😴</div><h2 style="font-weight:600">The Mac is offline</h2><p style="color:#8b9bb0">Jarvis runs on your Mac. Wake it up and <a href="javascript:location.reload()" style="color:#5ee1c6">retry</a>.</p></div>') }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, agent: !!agent, phones: phones.size })) }
  const tok = tokenOf(req, url)
  if (!PUBLIC(url.pathname) && !safeEq(tok, TOKEN)) { res.writeHead(404); return res.end('not found') }
  if (!agent || agent.readyState !== WebSocket.OPEN) return offline(res)
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const id = randomUUID()
    const body = Buffer.concat(chunks)
    const timer = setTimeout(() => { pending.delete(id); res.writeHead(504); res.end('mac timeout') }, 60000)
    pending.set(id, { res, timer, path: url.pathname, setCookie: url.searchParams.has('k') })
    agent.send(JSON.stringify({ t: 'req', id, method: req.method, path: url.pathname + (url.search ? url.search : ''), headers: { 'content-type': req.headers['content-type'] || '' }, body: body.length ? body.toString('base64') : '' }))
  })
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/agent') {
    if (!safeEq(req.headers['x-relay-token'] || url.searchParams.get('k'), TOKEN)) { socket.destroy(); return }
    return wss.handleUpgrade(req, socket, head, ws => onAgent(ws))
  }
  if (url.pathname === '/ws') {
    if (!safeEq(tokenOf(req, url), TOKEN)) { socket.destroy(); return }
    return wss.handleUpgrade(req, socket, head, ws => onPhone(ws))
  }
  socket.destroy()
})

function onAgent(ws) {
  if (agent && agent !== ws) { try { agent.close() } catch {} }
  agent = ws; console.log('agent connected')
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw) } catch { return }
    if (m.t === 'res') {
      const p = pending.get(m.id); if (!p) return
      pending.delete(m.id); clearTimeout(p.timer)
      const headers = { ...(m.headers || {}) }
      if (p.path === '/manifest.webmanifest') {       // start_url must carry the token: iOS PWAs don't share Safari cookies
        try { const j = JSON.parse(Buffer.from(m.body || '', 'base64').toString()); j.start_url = '/?k=' + TOKEN; j.scope = '/'; const b = Buffer.from(JSON.stringify(j)); headers['content-type'] = 'application/manifest+json'; headers['content-length'] = String(b.length); p.res.writeHead(m.status || 200, headers); return p.res.end(b) } catch {}
      }
      if (p.setCookie) headers['set-cookie'] = `k=${TOKEN}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`
      p.res.writeHead(m.status || 200, headers)
      p.res.end(m.body ? Buffer.from(m.body, 'base64') : undefined)
    } else if (m.t === 'ws') {
      const ph = phones.get(m.cid); if (ph && ph.readyState === WebSocket.OPEN) ph.send(m.data)
    } else if (m.t === 'wsclose') {
      const ph = phones.get(m.cid); if (ph) ph.close()
    }
  })
  ws.on('close', () => { if (agent === ws) agent = null; console.log('agent gone'); for (const [, p] of pending) { clearTimeout(p.timer); try { offline(p.res) } catch {} } pending.clear(); for (const ph of phones.values()) try { ph.close() } catch {} })
  const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); else clearInterval(ping) }, 25000)
}

function onPhone(ws) {
  if (!agent || agent.readyState !== WebSocket.OPEN) return ws.close()
  const cid = randomUUID(); phones.set(cid, ws)
  agent.send(JSON.stringify({ t: 'wsopen', cid }))
  ws.on('message', raw => { if (agent) agent.send(JSON.stringify({ t: 'ws', cid, data: raw.toString() })) })
  ws.on('close', () => { phones.delete(cid); if (agent && agent.readyState === WebSocket.OPEN) agent.send(JSON.stringify({ t: 'wsclose', cid })) })
}

server.listen(PORT, () => console.log('relay on', PORT))
