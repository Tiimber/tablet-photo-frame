'use strict'

const express   = require('express')
const multer    = require('multer')
const path      = require('path')
const fs        = require('fs')
const { spawn, spawnSync } = require('child_process')

// ── Server Configuration ─────────────────────────────────────────────────────

const SERVER_CONFIG_FILE = path.join(__dirname, 'server.config.json')
const DEFAULT_SERVER_CONFIG = {
  port: 3000,
  upload: { maxSizeMB: 1024, imageMagickMemoryMB: 200, imageMagickMapMB: 400 },
  polling: { photoReloadMinutes: 5, showNowSeconds: 2, queueInitialMs: 1200, queueActiveMs: 2000, queueErrorMs: 3000 },
  http: { timeoutSeconds: 10 },
  paths: { photos: './photos', videos: './videos', pending: './pending', thumbs: './thumbs', public: './public' }
}

function loadServerConfig() {
  try {
    const loaded = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8'))
    return { ...DEFAULT_SERVER_CONFIG, ...loaded }
  } catch { return { ...DEFAULT_SERVER_CONFIG } }
}

const serverConfig = loadServerConfig()

// Environment variable overrides
if (process.env.PORT) serverConfig.port = parseInt(process.env.PORT, 10)

const app         = express()
const PHOTOS_DIR  = path.join(__dirname, serverConfig.paths.photos)
const PUBLIC_DIR  = path.join(__dirname, serverConfig.paths.public)
const PENDING_DIR = path.join(__dirname, serverConfig.paths.pending)
const THUMBS_DIR  = path.join(__dirname, serverConfig.paths.thumbs)
const CONFIG_FILE = path.join(__dirname, 'config.json')
const META_FILE   = path.join(__dirname, 'meta.json')

fs.mkdirSync(PHOTOS_DIR,  { recursive: true })
fs.mkdirSync(PENDING_DIR, { recursive: true })
fs.mkdirSync(THUMBS_DIR,  { recursive: true })

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')) }
  catch { return {} }
}
function saveMeta(meta) { fs.writeFileSync(META_FILE, JSON.stringify(meta)) }

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v'])
const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS])

const DEFAULT_CONFIG = { interval: 10, transition: 'crossfade', kenBurns: false, order: 'random', fit: 'cover' }

function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } }
  catch { return { ...DEFAULT_CONFIG } }
}

function sanitizeName(name) {
  const ext  = path.extname(name).toLowerCase()
  const base = path.basename(name, path.extname(name)).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base + ext
}

// ── Transcoding queue ────────────────────────────────────────────────────────

const queue = []          // { id, origPath, outName, thumbName, status, error? }
let queueRunning = false

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

function enqueueMedia(origPath, outName) {
  const id        = Date.now() + '_' + Math.random().toString(36).slice(2)
  const thumbName = path.basename(outName, path.extname(outName)) + '_thumb.jpg'
  queue.push({ id, origPath, outName, thumbName, status: 'pending' })
  processQueue()
  return id
}

function finishQueueItem(item, outPath, code, signal, errTail) {
  queueRunning = false
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
  const done = queue.filter(i => i.status === 'done' || i.status === 'error')
  if (done.length > 20) queue.splice(queue.indexOf(done[0]), 1)
  processQueue()
}

function processQueue() {
  if (queueRunning) return
  const next = queue.find(i => i.status === 'pending')
  if (!next) return
  queueRunning = true
  next.status   = 'processing'
  next.progress = null
  console.log('[transcode] start:', next.outName)
  // Generate thumb now (not at enqueue), so only one thumb process runs at a time
  generateThumb(next.origPath, next.thumbName)

  const outPath = path.join(PHOTOS_DIR, next.outName)
  const isVideo = VIDEO_EXTS.has(path.extname(next.origPath).toLowerCase())

  if (!isVideo) {
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
    return
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
      queueRunning = false
      console.error('[transcode] probe failed:', next.outName, reason)
      try { fs.unlinkSync(next.origPath) } catch {}
      if (next.thumbName) try { fs.unlinkSync(path.join(THUMBS_DIR, next.thumbName)) } catch {}
      const done = queue.filter(i => i.status === 'done' || i.status === 'error')
      if (done.length > 20) queue.splice(queue.indexOf(done[0]), 1)
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
        next.progress = Math.min(99, Math.round(parseInt(m[1]) / durationUs * 100))
      }
    })
    ff.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-1000) })
    ff.on('close', (code, signal) => finishQueueItem(next, outPath, code, signal, errTail))
  })
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
app.use('/photos', express.static(PHOTOS_DIR))
app.use('/thumbs', express.static(THUMBS_DIR))
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

// Show-now command (for remote control from manage page)
let showNowCommand = null
let resumeSlideshow = false

function loadHASync() {
  try { return JSON.parse(fs.readFileSync(HA_SYNC_FILE, 'utf8')) }
  catch { return null }
}

const HA_ENTITIES = {
  interval:   { domain: 'input_number',  service: 'set_value',      key: 'value'  },
  transition: { domain: 'input_select',  service: 'select_option',  key: 'option', entity: 'slideshow_transition' },
  kenBurns:   { domain: 'input_boolean', service: null,             entity: 'slideshow_ken_burns' },
  order:      { domain: 'input_select',  service: 'select_option',  key: 'option', entity: 'slideshow_order' },
  fit:        { domain: 'input_select',  service: 'select_option',  key: 'option', entity: 'slideshow_fit' },
}
const HA_ENTITY_IDS = {
  interval:   'input_number.slideshow_interval',
  transition: 'input_select.slideshow_transition',
  kenBurns:   'input_boolean.slideshow_ken_burns',
  order:      'input_select.slideshow_order',
  fit:        'input_select.slideshow_fit',
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
  // Sync changed fields back to HA (only if something actually changed, preventing loops)
  syncToHA(cfg, old).catch(() => {})
})

// Expose polling intervals to frontend
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

// Show-now endpoint — allows remote control of slideshow
app.post('/api/show-now', express.json(), (req, res) => {
  const { filename } = req.body || {}
  if (!filename) return res.status(400).json({ error: 'filename required' })
  showNowCommand = { filename, timestamp: Date.now() }
  console.log('[show-now] SET:', filename)
  res.json({ ok: true })
})

app.get('/api/show-now', (req, res) => {
  const response = { filename: null, resume: false }
  
  if (resumeSlideshow) {
    response.resume = true
    resumeSlideshow = false
    console.log('[show-now] GET: resume=true')
  } else if (showNowCommand) {
    response.filename = showNowCommand.filename
    response.timestamp = showNowCommand.timestamp
    console.log('[show-now] GET: filename=', showNowCommand.filename)
    showNowCommand = null  // Clear after reading
  } else {
    console.log('[show-now] GET: nothing (current value:', showNowCommand, ')')
  }
  
  res.json(response)
})

app.post('/api/resume-slideshow', (req, res) => {
  resumeSlideshow = true
  res.json({ ok: true })
})

// Queue status endpoint — polled by manage.html
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
  if (!MEDIA_EXTS.has(path.extname(filename).toLowerCase())) {
    return res.status(400).json({ error: 'Unsupported file type' })
  }
  try {
    fs.unlinkSync(filePath)
    const meta = loadMeta()
    if (meta[filename]) { delete meta[filename]; saveMeta(meta) }
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

app.listen(serverConfig.port, () => console.log(`Slideshow server on :${serverConfig.port}`))
