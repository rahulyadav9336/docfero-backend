/**
 * DOCFERO BACKEND API
 * Handles PDF/Word/PPT conversions via LibreOffice headless + qpdf
 * 
 * Endpoints:
 *   POST /api/pdf-to-word   → converts PDF to DOCX
 *   POST /api/word-to-pdf   → converts DOCX to PDF
 *   POST /api/ppt-to-pdf    → converts PPTX to PDF
 *   POST /api/unlock-pdf    → removes PDF encryption via qpdf
 *   GET  /api/health        → health check
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 4000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/docfero-uploads';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/tmp/docfero-outputs';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024; // 100MB
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://docfero.com,https://www.docfero.com,http://localhost:3000,http://localhost:9999').split(',').map(s => s.trim().toLowerCase());
const FILE_CLEANUP_MINUTES = parseInt(process.env.FILE_CLEANUP_MINUTES) || 10;

// Allowed conversion target formats
const ALLOWED_CONVERT_FORMATS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'txt']);

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════

// CORS — only allow authorized domains
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const normalized = origin.trim().toLowerCase();
    if (ALLOWED_ORIGINS.includes(normalized)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400
}));

app.use(express.json());

// Rate limiting — in-memory per IP with reverse-proxy support
const rateLimit = {};
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 10; // 10 requests per minute per IP

function rateLimiter(req, res, next) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) || req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rateLimit[ip]) rateLimit[ip] = [];
  rateLimit[ip] = rateLimit[ip].filter(t => now - t < RATE_LIMIT_WINDOW);
  if (rateLimit[ip].length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }
  rateLimit[ip].push(now);
  next();
}

// Clean up rate limit memory every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const ip in rateLimit) {
    rateLimit[ip] = rateLimit[ip].filter(t => now - t < RATE_LIMIT_WINDOW);
    if (rateLimit[ip].length === 0) delete rateLimit[ip];
  }
}, 5 * 60 * 1000);

// Multer file upload config with unique sanitized names
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, uuidv4());
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = {
      '/api/pdf-to-word': ['.pdf'],
      '/api/word-to-pdf': ['.doc', '.docx'],
      '/api/ppt-to-pdf':  ['.ppt', '.pptx'],
      '/api/unlock-pdf':  ['.pdf']
    };
    const exts = allowed[req.path] || [];
    if (exts.includes(ext)) return cb(null, true);
    cb(new Error(`Invalid file type: ${ext}. Expected: ${exts.join(', ')}`));
  }
});

// Ensure directories exist
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ═══════════════════════════════════════════
// SECURE BINARY EXECUTION HELPERS
// ═══════════════════════════════════════════

/**
 * Execute an external executable safely without spawning an OS shell
 * Bypasses /bin/sh and cmd.exe to prevent command injection
 * @param {string} binary - name or absolute path of binary (soffice, qpdf)
 * @param {string[]} args - array of command line arguments
 * @param {number} timeoutMs - execution timeout in ms
 */
function runBinary(binary, args = [], timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      shell: false, // CRITICAL: Never invoke OS shell
      windowsHide: true
    }, (err, stdout, stderr) => {
      if (err) {
        const errorMsg = (stderr && stderr.toString().trim()) || err.message;
        reject(new Error(errorMsg));
      } else {
        resolve({
          stdout: stdout ? stdout.toString() : '',
          stderr: stderr ? stderr.toString() : ''
        });
      }
    });
  });
}

/**
 * Convert file using LibreOffice headless safely
 * @param {string} inputPath - path to input file
 * @param {string} outputDir - directory for output
 * @param {string} outputFormat - target format (pdf, docx, etc.)
 */
async function libreOfficeConvert(inputPath, outputDir, outputFormat) {
  const fmt = outputFormat.toLowerCase().trim();
  if (!ALLOWED_CONVERT_FORMATS.has(fmt)) {
    throw new Error(`Unsupported conversion format: ${fmt}`);
  }

  // Use execFile without shell to prevent injection
  const args = [
    '--headless',
    '--norestore',
    '--nologo',
    '--convert-to',
    fmt,
    '--outdir',
    outputDir,
    inputPath
  ];

  console.log(`[LibreOffice SafeExec] soffice ${args.join(' ')}`);
  await runBinary('soffice', args);

  // Find the generated output file
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(outputDir, `${baseName}.${fmt}`);

  if (!fs.existsSync(outputPath)) {
    throw new Error('Conversion failed — output file not created');
  }
  return outputPath;
}

/**
 * Sanitize filename to prevent HTTP header splitting / response pollution
 */
function sanitizeDownloadName(name, defaultExt = '.pdf') {
  if (typeof name !== 'string') return `document${defaultExt}`;
  const base = path.basename(name).replace(/[\r\n\0]/g, '').trim();
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || `document${defaultExt}`;
}

/**
 * Helper to delete directories and temporary files safely
 */
function cleanupDirs(...dirs) {
  dirs.forEach(dir => {
    if (dir && typeof dir === 'string') {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (e) {
        console.warn('[Cleanup Warning]', e.message);
      }
    }
  });
}

/**
 * Send the converted file as download and schedule cleanup
 */
function sendFileAndCleanup(res, filePath, downloadName, ...cleanupTargetDirs) {
  const safeName = sanitizeDownloadName(downloadName);
  res.download(filePath, safeName, (err) => {
    if (err && !res.headersSent) {
      console.error('[Download Error]', err.message);
      res.status(500).json({ error: 'Download failed' });
    }
    // Clean up temporary directories after sending
    setTimeout(() => {
      cleanupDirs(...cleanupTargetDirs);
    }, 5000);
  });
}

/**
 * Handle conversion errors and clean up immediately
 */
function handleError(res, err, operation, ...cleanupTargetDirs) {
  cleanupDirs(...cleanupTargetDirs);
  console.error(`[${operation} Error]`, err.message);
  const msg = err.message.includes('timeout') ? 'Conversion timed out. Try a smaller file.'
    : err.message.includes('Invalid file') ? err.message
    : `${operation} failed. Please try again.`;
  if (!res.headersSent) res.status(500).json({ error: msg });
}

// ═══════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ── PDF TO WORD ──
app.post('/api/pdf-to-word', rateLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
  const outputDir = path.join(OUTPUT_DIR, uuidv4());
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const outputPath = await libreOfficeConvert(req.file.path, outputDir, 'docx');
    const downloadName = path.basename(req.file.originalname, '.pdf') + '.docx';
    sendFileAndCleanup(res, outputPath, downloadName, req.file.destination, outputDir);
  } catch (err) {
    handleError(res, err, 'PDF to Word', req.file.destination, outputDir);
  }
});

// ── WORD TO PDF ──
app.post('/api/word-to-pdf', rateLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No Word file uploaded' });
  const outputDir = path.join(OUTPUT_DIR, uuidv4());
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const outputPath = await libreOfficeConvert(req.file.path, outputDir, 'pdf');
    const ext = path.extname(req.file.originalname);
    const downloadName = path.basename(req.file.originalname, ext) + '.pdf';
    sendFileAndCleanup(res, outputPath, downloadName, req.file.destination, outputDir);
  } catch (err) {
    handleError(res, err, 'Word to PDF', req.file.destination, outputDir);
  }
});

// ── PPT TO PDF ──
app.post('/api/ppt-to-pdf', rateLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PowerPoint file uploaded' });
  const outputDir = path.join(OUTPUT_DIR, uuidv4());
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const outputPath = await libreOfficeConvert(req.file.path, outputDir, 'pdf');
    const ext = path.extname(req.file.originalname);
    const downloadName = path.basename(req.file.originalname, ext) + '.pdf';
    sendFileAndCleanup(res, outputPath, downloadName, req.file.destination, outputDir);
  } catch (err) {
    handleError(res, err, 'PPT to PDF', req.file.destination, outputDir);
  }
});

// ── UNLOCK PDF (SECURED AGAINST COMMAND INJECTION) ──
app.post('/api/unlock-pdf', rateLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });

  // Strictly type-check and bound password input
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password.length > 256) {
    cleanupDirs(req.file.destination);
    return res.status(400).json({ error: 'Password exceeds maximum allowed length.' });
  }

  const outputDir = path.join(OUTPUT_DIR, uuidv4());
  fs.mkdirSync(outputDir, { recursive: true });
  const safeStem = req.file.filename.replace(/[^a-zA-Z0-9_-]/g, '_');
  const outputPath = path.join(outputDir, `unlocked_${safeStem}.pdf`);

  try {
    // Execute qpdf directly via execFile without shell interpolation
    const qpdfArgs = [];
    if (password) {
      qpdfArgs.push(`--password=${password}`);
    }
    qpdfArgs.push('--decrypt', req.file.path, outputPath);

    console.log(`[qpdf SafeExec] Unlocking PDF...`);
    await runBinary('qpdf', qpdfArgs);

    if (!fs.existsSync(outputPath)) throw new Error('Unlock failed — decrypted file not created');
    const downloadName = path.basename(req.file.originalname, '.pdf') + '_unlocked.pdf';
    sendFileAndCleanup(res, outputPath, downloadName, req.file.destination, outputDir);
  } catch (err) {
    // If password attempt failed, try decrypting without password parameter
    if (password) {
      try {
        const fallbackArgs = ['--decrypt', req.file.path, outputPath];
        await runBinary('qpdf', fallbackArgs);
        if (fs.existsSync(outputPath)) {
          const downloadName = path.basename(req.file.originalname, '.pdf') + '_unlocked.pdf';
          return sendFileAndCleanup(res, outputPath, downloadName, req.file.destination, outputDir);
        }
      } catch (e) { }
    }
    handleError(res, err, 'Unlock PDF', req.file.destination, outputDir);
  }
});

// ═══════════════════════════════════════════
// CLEANUP — Delete old temp files every N minutes
// ═══════════════════════════════════════════
setInterval(() => {
  const cutoff = Date.now() - FILE_CLEANUP_MINUTES * 60 * 1000;
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    try {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach(sub => {
        const fullPath = path.join(dir, sub);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            console.log(`[Cleanup] Removed ${fullPath}`);
          }
        } catch (e) { }
      });
    } catch (e) { }
  });
}, FILE_CLEANUP_MINUTES * 60 * 1000);

// ═══════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Maximum 100MB.' });
    return res.status(400).json({ error: err.message });
  }
  if (err.message.includes('Invalid file type')) return res.status(400).json({ error: err.message });
  console.error('[Server Error]', err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀 Docfero API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`   Max file: ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB`);
  console.log(`   Cleanup: every ${FILE_CLEANUP_MINUTES} min\n`);
});
