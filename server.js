'use strict'

const express   = require('express')
const multer    = require('multer')
const path      = require('path')
const fs        = require('fs')
const http      = require('http')
const { WebSocketServer } = require('ws')
const { spawn, spawnSync } = require('child_process')

// ── Server Configuration ─────────────────────────────────────────────────────

const SERVER_CONFIG_FILE = path.join(__dirname, 'server.config.json')
const DEFAULT_SERVER_CONFIG = {
  port: 3000,
  upload: { maxSizeMB: 1024, imageMagickMemoryMB: 200, imageMagickMapMB: 400 },
  polling: { photoReloadMinutes: 5, showNowSeconds: 2, queueInitialMs: 1200, queueActiveMs: 2000, queueErrorMs: 3000 },
  http: { timeoutSeconds: 10 },
  paths: { photos: './photos', videos: './videos', pending: './pending', thumbs: './thumbs', public: './public' },
  processing: { maxConcurrent: 3, maxConcurrentVideos: 1 }
}

function loadServerConfig() {
  try {
    const loaded = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8'))
    return {
      ...DEFAULT_SERVER_CONFIG,
      ...loaded,
      upload:     { ...DEFAULT_SERVER_CONFIG.upload,     ...(loaded.upload     || {}) },
      polling:    { ...DEFAULT_SERVER_CONFIG.polling,    ...(loaded.polling    || {}) },
      http:       { ...DEFAULT_SERVER_CONFIG.http,       ...(loaded.http       || {}) },
      paths:      { ...DEFAULT_SERVER_CONFIG.paths,      ...(loaded.paths      || {}) },
      processing: { ...DEFAULT_SERVER_CONFIG.processing, ...(loaded.processing || {}) },
    }
  } catch { return { ...DEFAULT_SERVER_CONFIG } }
}

const serverConfig = loadServerConfig()

// Environment variable overrides
if (process.env.PORT) serverConfig.port = parseInt(process.env.PORT, 10)

const app          = express()
const PHOTOS_DIR   = path.join(__dirname, serverConfig.paths.photos)
const PUBLIC_DIR   = path.join(__dirname, serverConfig.paths.public)
const PENDING_DIR  = path.join(__dirname, serverConfig.paths.pending)
const THUMBS_DIR   = path.join(__dirname, serverConfig.paths.thumbs)
const POSTERS_DIR  = path.join(__dirname, serverConfig.paths.posters || './posters')
const CONFIG_FILE  = path.join(__dirname, 'config.json')
const META_FILE    = path.join(__dirname, 'meta.json')

fs.mkdirSync(PHOTOS_DIR,  { recursive: true })
fs.mkdirSync(PENDING_DIR, { recursive: true })
fs.mkdirSync(THUMBS_DIR,  { recursive: true })
fs.mkdirSync(POSTERS_DIR, { recursive: true })

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')) }
  catch { return {} }
}
function saveMeta(meta) { fs.writeFileSync(META_FILE, JSON.stringify(meta)) }

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v'])
const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS])

const DEFAULT_CONFIG = { interval: 10, transition: 'crossfade', kenBurns: false, kenBurnsSpeed: 'normal', order: 'random', fit: 'cover' }

function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } }
  catch { return { ...DEFAULT_CONFIG } }
}

function sanitizeName(name) {
  const ext  = path.extname(name).toLowerCase()
  const base = path.basename(name, path.extname(name)).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base + ext
}

// ── WebSocket broadcast ───────────────────────────────────────────────────────

// Populated after wss is created below
let wss = null

function broadcast(msg) {
  if (!wss) return
  const data = JSON.stringify(msg)
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(data)
  }
}

// ── Transcoding queue ────────────────────────────────────────────────────────

// queue items: { id, origPath, outName, thumbName, status, error?, progress?, isVideo }
const queue = []

// Concurrency counters
let runningTotal = 0
let runningVideos = 0

const MAX_CONCURRENT       = serverConfig.processing.maxConcurrent
const MAX_CONCURRENT_VIDEOS = serverConfig.processing.maxConcurrentVideos

// Quickly generate a small preview thumbnail in background (fire-and-forget)
function generateThumb(origPath, thumbName) {
  const ext    = path.extname(origPath).toLowerCase()
  const outPath = path.join(THUMBS_DIR, thumbName)
  const isVid  = VIDEO_EXTS.has(ext)
  const [bin, args] = isVid
    ? ['ffmpeg', ['-ss', '0', '-i', origPath, '-frames:v', '1',
                  '-vf', 'scale=400:400:force_original_aspect_ratio=decrease',
                  '-y', outPath]]
    : ['convert', [origPath + '[0]', '-auto-orient', '-thumbnail', '400x400>', outPath]]
  const proc = spawn(bin, args, { stdio: 'ignore' })
  proc.on('close', code => { if (code !== 0) try { fs.unlinkSync(outPath) } catch {} })
}

/**
 * Generate a full-resolution first-frame JPEG poster for a video.
 * Stored in POSTERS_DIR as <basename>.jpg (e.g. myvideo.mp4 → myvideo.jpg).
 * Fire-and-forget — errors are silently ignored.
 */
function generatePoster(videoPath, posterName) {
  const outPath = path.join(POSTERS_DIR, posterName)
  const proc = spawn('ffmpeg', [
    '-ss', '0', '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'scale=iw:ih',   // keep original resolution
    '-q:v', '2',            // high quality JPEG
    '-y', outPath
  ], { stdio: 'ignore' })
  proc.on('close', code => { if (code !== 0) try { fs.unlinkSync(outPath) } catch {} })
}

function enqueueMedia(origPath, outName) {
  const id        = Date.now() + '_' + Math.random().toString(36).slice(2)
  const thumbName = path.basename(outName, path.extname(outName)) + '_thumb.jpg'
  const isVideo   = VIDEO_EXTS.has(path.extname(origPath).toLowerCase())
  queue.push({ id, origPath, outName, thumbName, status: 'pending', isVideo })
  broadcastQueue()
  processQueue()
  return id
}

function broadcastQueue() {
  broadcast({
    type: 'queue',
    items: queue.map(({ id, outName, thumbName, status, error, progress }) =>
      ({ id, name: outName, thumbName, status, error, progress }))
  })
}

function finishQueueItem(item, outPath, code, signal, errTail) {
  runningTotal--
  if (item.isVideo) runningVideos--

  if (code === 0) {
    item.status   = 'done'
    item.progress = 100
    console.log('[transcode] done:', item.outName)
    try { fs.unlinkSync(item.origPath) } catch {}  // delete original only on success
  } else {
    item.status = 'error'
    const lastLine = errTail.trim().split('\n').filter(Boolean).pop() || ''
    if (code === null && signal) {
      item.error = signal === 'SIGKILL' ? 'Killed (out of memory) — re-upload to retry' : `Killed by ${signal}`
    } else {
      item.error = lastLine || `Exit ${code}`
    }
    console.error('[transcode] failed:', item.outName, '| code:', code, 'signal:', signal, '\n', lastLine)
    try { fs.unlinkSync(outPath) } catch {}
    // origPath (in pending/) is intentionally kept on failure so a server restart will retry it
  }
  if (item.thumbName) try { fs.unlinkSync(path.join(THUMBS_DIR, item.thumbName)) } catch {}

  // Prune old completed/errored items (keep at most 20)
  const done = queue.filter(i => i.status === 'done' || i.status === 'error')
  if (done.length > 20) queue.splice(queue.indexOf(done[0]), 1)

  broadcastQueue()
  processQueue()
}

function processQueue() {
  // Start as many pending items as concurrency limits allow
  for (const next of queue) {
    if (next.status !== 'pending') continue
    if (runningTotal >= MAX_CONCURRENT) break
    if (next.isVideo && runningVideos >= MAX_CONCURRENT_VIDEOS) continue

    runningTotal++
    if (next.isVideo) runningVideos++
    next.status   = 'processing'
    next.progress = null
    console.log('[transcode] start:', next.outName)
    broadcastQueue()

    // Generate thumb now (not at enqueue), so thumb processes are staggered
    generateThumb(next.origPath, next.thumbName)
    // Generate poster (first-frame JPEG) for videos
    if (next.isVideo) {
      const posterName = path.basename(next.outName, path.extname(next.outName)) + '.jpg'
      generatePoster(next.origPath, posterName)
    }

    const outPath = path.join(PHOTOS_DIR, next.outName)

    if (!next.isVideo) {
      // Images → ImageMagick with memory limits to avoid OOM on large HEICs
      const proc = spawn('convert', [
        '-limit', 'memory', `${serverConfig.upload.imageMagickMemoryMB}MiB`,
        '-limit', 'map', `${serverConfig.upload.imageMagickMapMB}MiB`,
        next.origPath + '[0]', '-auto-orient', '-resize', '1920x1080>',
        '-strip', '-quality', '85', outPath
      ])
      let errTail = ''
      proc.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-1000) })
      proc.on('close', (code, signal) => {
        if (code === 0) {
          // Re-embed only the date tags from the original before deleting it
          const et = spawn('exiftool', [
            '-TagsFromFile', next.origPath,
            '-DateTimeOriginal', '-CreateDate', '-DateTime', '-ModifyDate',
            '-overwrite_original', '-q', outPath
          ])
          et.on('close', () => finishQueueItem(next, outPath, code, signal, errTail))
        } else {
          finishQueueItem(next, outPath, code, signal, errTail)
        }
      })
      continue
    }

    // Videos → probe duration first, then validate file is complete, then ffmpeg
    const probe = spawn('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', next.origPath
    ])
    let probeOut = '', probeErr = ''
    probe.stdout.on('data', d => { probeOut += d.toString() })
    probe.stderr.on('data', d => { probeErr += d.toString() })
    probe.on('close', (probeCode) => {
      if (probeCode !== 0) {
        // File is unreadable/corrupt — likely incomplete upload
        const reason = probeErr.trim().split('\n').filter(Boolean).pop() || 'Unreadable file'
        next.status = 'error'
        next.error  = reason
        runningTotal--
        runningVideos--
        console.error('[transcode] probe failed:', next.outName, reason)
        try { fs.unlinkSync(next.origPath) } catch {}
        if (next.thumbName) try { fs.unlinkSync(path.join(THUMBS_DIR, next.thumbName)) } catch {}
        const done = queue.filter(i => i.status === 'done' || i.status === 'error')
        if (done.length > 20) queue.splice(queue.indexOf(done[0]), 1)
        broadcastQueue()
        processQueue()
        return
      }

      let durationUs = 0
      try { durationUs = Math.round(parseFloat(JSON.parse(probeOut).format.duration) * 1e6) } catch {}

      const ff = spawn('ffmpeg', [
        '-i', next.origPath,
        '-map_metadata', '0',
        '-vf', "scale=w='min(iw,1920)':h='min(ih,1080)':force_original_aspect_ratio=decrease," +
               "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        '-c:v', 'libx264', '-crf', '26', '-preset', 'fast',
        '-an', '-movflags', '+faststart',
        '-progress', 'pipe:1',
        '-y', outPath
      ])

      let errTail = ''
      ff.stdout.on('data', d => {
        const m = d.toString().match(/out_time_us=(\d+)/)
        if (m && durationUs > 0) {
          const prev = next.progress
          next.progress = Math.min(99, Math.round(parseInt(m[1]) / durationUs * 100))
          if (next.progress !== prev) broadcastQueue()
        }
      })
      ff.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-1000) })
      ff.on('close', (code, signal) => finishQueueItem(next, outPath, code, signal, errTail))
    })
  }
}

// Re-queue any files left in pending/ from a previous run.
// Skip obviously incomplete files (< 512 bytes).
fs.readdirSync(PENDING_DIR).forEach(f => {
  const ext = path.extname(f).toLowerCase()
  if (!MEDIA_EXTS.has(ext)) return
  const fullPath = path.join(PENDING_DIR, f)
  try {
    const { size } = fs.statSync(fullPath)
    if (size < 512) {
      console.warn('[startup] deleting incomplete file:', f, `(${size} bytes)`)
      fs.unlinkSync(fullPath)
      return
    }
  } catch { return }
  const outExt = VIDEO_EXTS.has(ext) ? '.mp4' : '.jpg'
  enqueueMedia(fullPath, path.basename(f, ext) + outExt)
})

// ── Multer ───────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PENDING_DIR),
  filename: (req, file, cb) => cb(null, sanitizeName(file.originalname))
})

const upload = multer({
  storage,
  limits: { fileSize: serverConfig.upload.maxSizeMB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, MEDIA_EXTS.has(ext))
  }
})

// ── Routes ───────────────────────────────────────────────────────────────────

app.use(express.json())
app.use('/photos',  express.static(PHOTOS_DIR))
app.use('/thumbs',  express.static(THUMBS_DIR))
app.use('/posters', express.static(POSTERS_DIR))
app.use(express.static(PUBLIC_DIR))

app.get('/',          (req, res) => res.redirect('/slideshow'))
app.get('/slideshow', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'slideshow.html')))
app.get('/manage',    (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'manage.html')))

app.get('/api/photos', (req, res) => {
  try {
    const files = fs.readdirSync(PHOTOS_DIR)
      .filter(f => MEDIA_EXTS.has(path.extname(f).toLowerCase()))
      .sort()
      .map(f => ({ name: f, size: fs.statSync(path.join(PHOTOS_DIR, f)).size }))
    if (files.length === 0) return res.json([])
    // Batch-read EXIF dates (images only; videos keep their container date)
    try {
      const paths = files.map(f => path.join(PHOTOS_DIR, f.name))
      const et = spawnSync('exiftool', ['-json', '-q',
        '-DateTimeOriginal', '-CreateDate', '-FileModifyDate', ...paths],
        { timeout: serverConfig.http.timeoutSeconds * 1000 })
      if (et.status === 0) {
        const exifList = JSON.parse(et.stdout.toString())
        const dateMap = {}
        for (const item of exifList) {
          const fn  = path.basename(item.SourceFile)
          const raw = item.DateTimeOriginal || item.CreateDate || item.FileModifyDate || ''
          const m   = raw.match(/^(\d{4}):(\d{2}):(\d{2})/)
          dateMap[fn] = (m && m[1] !== '0000') ? `${m[1]}-${m[2]}-${m[3]}` : null
        }
        files.forEach(f => { f.date = dateMap[f.name] || null })
      }
    } catch { /* exiftool unavailable — dates omitted */ }
    res.json(files)
  } catch { res.json([]) }
})


// ── Home Assistant two-way sync ───────────────────────────────────────────────
const HA_SYNC_FILE = path.join(__dirname, 'ha_sync.json')

function loadHASync() {
  try { return JSON.parse(fs.readFileSync(HA_SYNC_FILE, 'utf8')) }
  catch { return null }
}

const HA_ENTITY_IDS = {
  interval:      'input_number.slideshow_interval',
  transition:    'input_select.slideshow_transition',
  kenBurns:      'input_boolean.slideshow_ken_burns',
  kenBurnsSpeed: 'input_select.slideshow_ken_burns_speed',
  order:         'input_select.slideshow_order',
  fit:           'input_select.slideshow_fit',
}

async function syncToHA(newCfg, oldCfg) {
  const ha = loadHASync()
  if (!ha || !ha.url || !ha.token) return
  const base    = ha.url.replace(/\/$/, '')
  const headers = { 'Authorization': 'Bearer ' + ha.token, 'Content-Type': 'application/json' }

  const calls = []

  if (oldCfg.interval !== newCfg.interval)
    calls.push(fetch(`${base}/api/services/input_number/set_value`, { method:'POST', headers,
      body: JSON.stringify({ entity_id: HA_ENTITY_IDS.interval, value: newCfg.interval }) }))

  if (oldCfg.transition !== newCfg.transition)
    calls.push(fetch(`${base}/api/services/input_select/select_option`, { method:'POST', headers,
      body: JSON.stringify({ entity_id: HA_ENTITY_IDS.transition, option: newCfg.transition }) }))

  if (oldCfg.kenBurns !== newCfg.kenBurns) {
    const svc = newCfg.kenBurns ? 'turn_on' : 'turn_off'
    calls.push(fetch(`${base}/api/services/input_boolean/${svc}`, { method:'POST', headers,
      body: JSON.stringify({ entity_id: HA_ENTITY_IDS.kenBurns }) }))
  }

  if (oldCfg.order !== newCfg.order)
    calls.push(fetch(`${base}/api/services/input_select/select_option`, { method:'POST', headers,
      body: JSON.stringify({ entity_id: HA_ENTITY_IDS.order, option: newCfg.order }) }))

  if (oldCfg.fit !== newCfg.fit)
    calls.push(fetch(`${base}/api/services/input_select/select_option`, { method:'POST', headers,
      body: JSON.stringify({ entity_id: HA_ENTITY_IDS.fit, option: newCfg.fit }) }))

  if (oldCfg.kenBurnsSpeed !== newCfg.kenBurnsSpeed)
    calls.push(fetch(`${base}/api/services/input_select/select_option`, { method:'POST', headers,
      body: JSON.stringify({ entity_id: HA_ENTITY_IDS.kenBurnsSpeed, option: newCfg.kenBurnsSpeed }) }))

  if (calls.length === 0) return
  try {
    await Promise.all(calls)
    console.log('[ha-sync] pushed', calls.length, 'change(s) to HA')
  } catch(e) {
    console.error('[ha-sync] error:', e.message)
  }
}

app.get('/api/config', (req, res) => res.json(loadConfig()))

app.post('/api/config', async (req, res) => {
  const old = loadConfig()
  const cfg = { ...old, ...req.body }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg))
  res.json(cfg)
  // Broadcast config change to all connected WebSocket clients
  broadcast({ type: 'config', config: cfg })
  // Sync changed fields back to HA (only if something actually changed, preventing loops)
  syncToHA(cfg, old).catch(() => {})
})

// Expose polling intervals to frontend (kept for backwards compat)
app.get('/api/config/polling', (req, res) => {
  res.json(serverConfig.polling)
})

// ── HA sync credentials ───────────────────────────────────────────────────────
app.get('/api/ha-sync', (req, res) => {
  const ha = loadHASync()
  res.json({ configured: !!(ha && ha.url && ha.token), url: ha?.url || '' })
})

app.post('/api/ha-sync', express.json(), (req, res) => {
  const { url, token } = req.body || {}
  if (!url || !token) return res.status(400).json({ error: 'url and token required' })
  fs.writeFileSync(HA_SYNC_FILE, JSON.stringify({ url: url.trim(), token: token.trim() }))
  res.json({ ok: true })
})

// Show-now endpoint — allows remote control of slideshow via WebSocket broadcast
// HTTP endpoints kept for backwards compatibility
app.post('/api/show-now', express.json(), (req, res) => {
  const { filename } = req.body || {}
  if (!filename) return res.status(400).json({ error: 'filename required' })
  console.log('[show-now] broadcast:', filename)
  broadcast({ type: 'show-now', filename })
  res.json({ ok: true })
})

// Legacy polling endpoint — returns empty so old clients don't break
app.get('/api/show-now', (req, res) => {
  res.json({ filename: null, resume: false })
})

app.post('/api/resume-slideshow', (req, res) => {
  broadcast({ type: 'resume-slideshow' })
  res.json({ ok: true })
})

// ── IKEA remote / blueprint endpoints ────────────────────────────────────────
app.post('/api/remote/next',         (req, res) => { broadcast({ type: 'remote-next' });         res.json({ ok: true }) })
app.post('/api/remote/prev',         (req, res) => { broadcast({ type: 'remote-prev' });         res.json({ ok: true }) })
app.post('/api/remote/toggle-pause', (req, res) => { broadcast({ type: 'remote-toggle-pause' }); res.json({ ok: true }) })

let lastSettingsCall = 0
app.post('/api/remote/settings', (req, res) => {
  const now = Date.now()
  if (now - lastSettingsCall < 3000) return res.json({ ok: true, throttled: true })
  lastSettingsCall = now
  broadcast({ type: 'remote-settings' })
  res.json({ ok: true })
})

// ── HA state proxy — lets frontend fetch any entity without exposing token ──
app.get('/api/ha-state/:entity', async (req, res) => {
  const ha = loadHASync()
  if (!ha || !ha.url || !ha.token) return res.status(503).json({ error: 'HA not configured' })
  try {
    const r = await fetch(`${ha.url.replace(/\/$/,'')}/api/states/${req.params.entity}`, {
      headers: { 'Authorization': 'Bearer ' + ha.token }
    })
    if (!r.ok) return res.status(r.status).json({ error: 'HA error' })
    res.json(await r.json())
  } catch(e) { res.status(502).json({ error: String(e) }) }
})

// HA template proxy — evaluate a Jinja2 template via HA API
app.post('/api/ha-template', express.json(), async (req, res) => {
  const ha = loadHASync()
  if (!ha || !ha.url || !ha.token) return res.status(503).json({ error: 'HA not configured' })
  const { template } = req.body || {}
  if (!template) return res.status(400).json({ error: 'template required' })
  try {
    const r = await fetch(`${ha.url.replace(/\/$/,'')}/api/template`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + ha.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template })
    })
    if (!r.ok) return res.status(r.status).json({ error: 'HA error' })
    res.type('text').send(await r.text())
  } catch(e) { res.status(502).json({ error: String(e) }) }
})

// Dashboard toggle — callable from HA rest_command
app.post('/api/remote/dashboard', (req, res) => {
  broadcast({ type: 'remote-dashboard' })
  res.json({ ok: true })
})

// Dashboard shortcut — placeholder, wire up HA actions here
app.post('/api/dashboard/shortcut', express.json(), (req, res) => {
  const { action } = req.body || {}
  console.log('[dashboard] shortcut:', action)
  res.json({ ok: true, action })
})

// ── Lights config ─────────────────────────────────────────────────────────────
const LIGHTS_FILE = path.join(__dirname, 'lights.json')
app.get('/api/lights/config', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(LIGHTS_FILE, 'utf8'))) }
  catch { res.json({ rooms: [] }) }
})

// ── HA service proxy ──────────────────────────────────────────────────────────
app.post('/api/ha-service', express.json(), async (req, res) => {
  const ha = loadHASync()
  if (!ha || !ha.url || !ha.token) return res.status(503).json({ error: 'HA not configured' })
  const { domain, service, data } = req.body || {}
  if (!domain || !service) return res.status(400).json({ error: 'domain and service required' })
  try {
    const r = await fetch(`${ha.url.replace(/\/$/,'')}/api/services/${domain}/${service}`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + ha.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    })
    if (!r.ok) return res.status(r.status).json({ error: 'HA error' })
    res.json({ ok: true })
  } catch(e) { res.status(502).json({ error: String(e) }) }
})

// Queue status endpoint — polled by manage.html as fallback
app.get('/api/queue', (req, res) => {
  res.json(queue.map(({ id, outName, thumbName, status, error, progress }) =>
    ({ id, name: outName, thumbName, status, error, progress })))
})

app.post('/upload', upload.array('photos'), (req, res) => {
  const results = []
  for (const file of (req.files || [])) {
    const inExt  = path.extname(file.originalname).toLowerCase()
    const outExt = VIDEO_EXTS.has(inExt) ? '.mp4' : '.jpg'
    const base   = path.basename(sanitizeName(file.originalname), inExt)
    const outName = base + outExt
    const queueId = enqueueMedia(file.path, outName)
    results.push({ name: file.originalname, queued: true, queueId, outputName: outName })
  }
  res.json({ ok: true, files: results })
})

// Multer error handler — fires when a connection drops mid-upload.
// Clean up any partially-written files multer already saved.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (req.files) {
    for (const f of req.files) {
      try { fs.unlinkSync(f.path) } catch {}
    }
  }
  const msg = err?.message || 'Upload error'
  console.error('[upload] error:', msg)
  res.status(400).json({ error: msg })
})

app.get('/api/version', (req, res) => {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname })
  const hash = result.status === 0 ? result.stdout.toString().trim() : 'unknown'
  res.json({ commit: hash })
})

// Return the poster (first-frame JPEG) path for a video, or 404 if not yet generated
app.get('/api/photos/:filename/poster', (req, res) => {
  const filename   = path.basename(req.params.filename)
  const ext        = path.extname(filename).toLowerCase()
  if (!VIDEO_EXTS.has(ext)) return res.status(400).json({ error: 'Not a video' })
  const posterName = path.basename(filename, ext) + '.jpg'
  const posterPath = path.join(POSTERS_DIR, posterName)
  if (!fs.existsSync(posterPath)) return res.status(404).json({ error: 'Poster not found' })
  res.sendFile(posterPath)
})

app.get('/api/photos/:filename/info', (req, res) => {
  const filename = path.basename(req.params.filename)
  const filePath = path.join(PHOTOS_DIR, filename)
  if (!MEDIA_EXTS.has(path.extname(filename).toLowerCase())) {
    return res.status(400).json({ error: 'Unsupported file type' })
  }
  try {
    const stat = fs.statSync(filePath)
    const meta = loadMeta()
    const displayName = meta[filename]?.displayName || ''
    // Read EXIF date for this single file
    let date = null
    try {
      const et = spawnSync('exiftool', ['-json', '-q',
        '-DateTimeOriginal', '-CreateDate', '-FileModifyDate', filePath],
        { timeout: serverConfig.http.timeoutSeconds * 1000 })
      if (et.status === 0) {
        const exifList = JSON.parse(et.stdout.toString())
        if (exifList.length > 0) {
          const item = exifList[0]
          const raw = item.DateTimeOriginal || item.CreateDate || item.FileModifyDate || ''
          const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})/)
          date = (m && m[1] !== '0000') ? `${m[1]}-${m[2]}-${m[3]}` : null
        }
      }
    } catch { /* exiftool unavailable */ }
    res.json({ filename, size: stat.size, displayName, date })
  } catch { res.status(404).json({ error: 'Not found' }) }
})

app.get('/api/meta', (req, res) => res.json(loadMeta()))

app.patch('/api/meta/:filename', (req, res) => {
  const filename = path.basename(req.params.filename)
  const { displayName } = req.body
  if (typeof displayName !== 'string') return res.status(400).json({ error: 'displayName required' })
  const meta = loadMeta()
  meta[filename] = { ...meta[filename], displayName: displayName.trim().slice(0, 200) }
  saveMeta(meta)
  res.json({ ok: true })
})

app.delete('/api/photos/:filename', (req, res) => {
  const filename = path.basename(req.params.filename)
  const filePath = path.join(PHOTOS_DIR, filename)
  const ext      = path.extname(filename).toLowerCase()
  if (!MEDIA_EXTS.has(ext)) {
    return res.status(400).json({ error: 'Unsupported file type' })
  }
  try {
    fs.unlinkSync(filePath)
    const meta = loadMeta()
    if (meta[filename]) { delete meta[filename]; saveMeta(meta) }
    // Clean up poster for videos
    if (VIDEO_EXTS.has(ext)) {
      const posterName = path.basename(filename, ext) + '.jpg'
      try { fs.unlinkSync(path.join(POSTERS_DIR, posterName)) } catch {}
    }
    // Notify all clients that a file was deleted
    broadcast({ type: 'photo-deleted', filename })
    res.json({ ok: true })
  }
  catch { res.status(404).json({ error: 'Not found' }) }
})

// Trim a video to [start, end] seconds using ffmpeg -c copy (fast, no re-encode)
app.post('/api/trim/:filename', (req, res) => {
  const filename = path.basename(req.params.filename)
  const ext = path.extname(filename).toLowerCase()
  if (!VIDEO_EXTS.has(ext)) return res.status(400).json({ error: 'Not a video' })
  const { start, end } = req.body
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end <= start + 0.1) {
    return res.status(400).json({ error: 'Invalid start/end' })
  }
  const srcPath = path.join(PHOTOS_DIR, filename)
  if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'Not found' })
  const tmpPath = srcPath + '.tmp.mp4'
  const ff = spawn('ffmpeg', [
    '-ss', String(start),
    '-i', srcPath,
    '-t', String(end - start),
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', tmpPath
  ])
  let errBuf = ''
  ff.stderr.on('data', d => { errBuf = (errBuf + d.toString()).slice(-2000) })
  ff.on('close', code => {
    if (code !== 0) {
      try { fs.unlinkSync(tmpPath) } catch {}
      const msg = errBuf.trim().split('\n').filter(Boolean).pop() || 'ffmpeg failed'
      return res.status(500).json({ error: msg })
    }
    try { fs.renameSync(tmpPath, srcPath) } catch (e) {
      try { fs.unlinkSync(tmpPath) } catch {}
      return res.status(500).json({ error: String(e.message) })
    }
    res.json({ ok: true })
  })
})

// ── HTTP server + WebSocket server ───────────────────────────────────────────

const server = http.createServer(app)

wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  console.log('[ws] client connected, total:', wss.clients.size)

  // Send current queue state immediately on connect
  ws.send(JSON.stringify({
    type: 'queue',
    items: queue.map(({ id, outName, thumbName, status, error, progress }) =>
      ({ id, name: outName, thumbName, status, error, progress }))
  }))

  ws.on('close', () => {
    console.log('[ws] client disconnected, total:', wss.clients.size)
  })

  ws.on('error', (err) => {
    console.error('[ws] error:', err.message)
  })
})

server.listen(serverConfig.port, () => console.log(`Slideshow server on :${serverConfig.port}`))
