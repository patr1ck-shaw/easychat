import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_ROOT = path.resolve(__dirname, '../web');
const DATA_DIR = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data' : __dirname);
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(DATA_DIR, 'presets.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, 'presets.example.json');
const ADMIN_PASSWORD = process.env.EASYCHAT_ADMIN_PASSWORD || '';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const LOG_PATH = process.env.LOG_PATH || path.join(DATA_DIR, 'easychat.log');
const SESSIONS_PATH = process.env.SESSIONS_PATH || path.join(DATA_DIR, 'sessions.json');
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '64mb';
const IMAGE_TASK_TTL_MS = Number(process.env.IMAGE_TASK_TTL_MS || 60 * 60 * 1000);
const IMAGE_TASK_CLEANUP_MS = Number(process.env.IMAGE_TASK_CLEANUP_MS || 5 * 60 * 1000);

const imageTasks = new Map();

app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    writeLog('HTTP', `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

if (LOG_PATH) {
  const logDir = path.dirname(LOG_PATH);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

const sessionsDir = path.dirname(SESSIONS_PATH);
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

function writeLog(level, message, extra = null) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  console.log(line);
  if (LOG_PATH) {
    try {
      fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf-8');
    } catch (error) {
      console.error(`[LOG_WRITE_ERROR] ${error.message}`);
    }
  }
}

function ensureConfigFile() {
  if (fs.existsSync(CONFIG_PATH)) return;
  if (!fs.existsSync(EXAMPLE_CONFIG_PATH)) {
    throw new Error('缺少 presets.json 和 presets.example.json');
  }
  fs.copyFileSync(EXAMPLE_CONFIG_PATH, CONFIG_PATH);
}

function readJson(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function buildUpstreamHeaders(apiKey, extra = {}) {
  const cleanKey = String(apiKey || '').trim();
  return {
    Authorization: `Bearer ${cleanKey}`,
    // 兼容不同网关：OpenAI 常用 Bearer，部分中转识别 x-api-key，Google/Gemini 兼容层识别 x-goog-api-key。
    'x-api-key': cleanKey,
    'x-goog-api-key': cleanKey,
    'Content-Type': 'application/json',
    ...extra
  };
}

const DEFAULT_IMAGE_FALLBACK_SIZES = ['2560x1440', '1920x1080', '1024x1024'];
const IMAGE_SAME_SIZE_RETRIES = Math.max(1, Number(process.env.IMAGE_SAME_SIZE_RETRIES || 2));

function stringifyErrorDetails(details) {
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details || '');
  } catch (_) {
    return String(details || '');
  }
}

function isUnsupportedImagePayloadError(status, details) {
  const text = stringifyErrorDetails(details).toLowerCase();
  return [400, 404, 422].includes(Number(status)) && (
    text.includes('response_format') ||
    text.includes('unsupported parameter') ||
    text.includes('unknown parameter') ||
    text.includes('invalid parameter') ||
    text.includes('invalid_request_error') ||
    text.includes('not supported') ||
    text.includes('unsupported value')
  );
}

function isTransientImageFailure(status, details) {
  const code = Number(status);
  const text = stringifyErrorDetails(details).toLowerCase();
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(code)) return true;

  return (
    text.includes('stream disconnected') ||
    text.includes('internal_server_error') ||
    text.includes('timeout') ||
    text.includes('temporarily unavailable') ||
    text.includes('service unavailable') ||
    text.includes('gateway timeout') ||
    text.includes('connection reset') ||
    text.includes('econnreset') ||
    text.includes('rate limit') ||
    text.includes('overloaded')
  );
}

function normalizeImageSize(size) {
  const value = String(size || '').trim();
  if (!value) return '';
  return /^\d{2,5}x\d{2,5}$/i.test(value) ? value.toLowerCase() : '';
}

function uniqueNonEmptyStrings(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizePreset(preset, index) {
  return {
    id: String(preset.id || `preset-${Date.now()}-${index}`),
    name: String(preset.name || `Preset ${index + 1}`).trim(),
    baseUrl: normalizeBaseUrl(preset.baseUrl || ''),
    model: String(preset.model || '').trim(),
    imageModel: String(preset.imageModel || '').trim(),
    apiKey: String(preset.apiKey || '').trim()
  };
}

function validateConfig(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('配置格式无效');
  }

  const presets = Array.isArray(input.presets) ? input.presets.map(normalizePreset) : [];
  if (presets.length === 0) {
    throw new Error('至少需要一个预设');
  }

  for (const preset of presets) {
    if (!preset.id) throw new Error('预设 id 不能为空');
    if (!preset.name) throw new Error(`预设 ${preset.id} 的名称不能为空`);
    if (!preset.baseUrl) throw new Error(`预设 ${preset.name} 的 Base URL 不能为空`);
    if (!/^https?:\/\//i.test(preset.baseUrl)) throw new Error(`预设 ${preset.name} 的 Base URL 必须以 http:// 或 https:// 开头`);
    if (!preset.model) throw new Error(`预设 ${preset.name} 的 Model 不能为空`);
    if (!preset.apiKey) throw new Error(`预设 ${preset.name} 的 API Key 不能为空`);
  }

  const defaultPresetId = String(input.defaultPresetId || presets[0].id);
  if (!presets.some((preset) => preset.id === defaultPresetId)) {
    throw new Error('默认预设不存在');
  }

  return {
    appName: String(input.appName || 'EasyChat AI').trim() || 'EasyChat AI',
    backgroundImage: String(input.backgroundImage || '').trim(),
    defaultPresetId,
    presets
  };
}

function loadConfig() {
  ensureConfigFile();
  return validateConfig(readJson(CONFIG_PATH));
}

function sanitizeStoredContent(content) {
  if (typeof content === 'string') {
    return content.replace(/data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+/gi, (dataUrl) => {
      try {
        return `/uploads/${saveBase64Image(dataUrl)}`;
      } catch (_) {
        return '[图片数据已省略]';
      }
    });
  }

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return part;

      if (part.type === 'text' && typeof part.text === 'string') {
        return { ...part, text: sanitizeStoredContent(part.text) };
      }

      if (part.type === 'image_url') {
        const rawUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (typeof rawUrl === 'string' && /^data:image\//i.test(rawUrl)) {
          try {
            const storedUrl = `/uploads/${saveBase64Image(rawUrl)}`;
            if (typeof part.image_url === 'string') {
              return { ...part, image_url: storedUrl };
            }
            return {
              ...part,
              image_url: {
                ...(part.image_url || {}),
                url: storedUrl
              }
            };
          } catch (_) {
            return { type: 'text', text: '[图片数据已省略]' };
          }
        }
      }

      return part;
    });
  }

  return content ?? '';
}

function normalizeSessionsStore(input) {
  const rawSessions = Array.isArray(input?.sessions) ? input.sessions : [];
  const sessions = rawSessions
    .map((session, index) => {
      const id = String(session?.id || '').trim() || `session-${Date.now()}-${index}`;
      const title = String(session?.title || 'New Chat').trim() || 'New Chat';
      const history = Array.isArray(session?.history)
        ? session.history
            .filter((msg) => msg && typeof msg === 'object')
            .map((msg) => ({
              role: String(msg.role || '').trim() || 'user',
              content: sanitizeStoredContent(msg.content)
            }))
        : [];
      return { id, title, history };
    })
    .slice(0, 50);

  const wantedCurrentId = String(input?.currentSessionId || '').trim();
  const currentSessionId = sessions.some((s) => s.id === wantedCurrentId)
    ? wantedCurrentId
    : sessions[0]?.id || null;

  return { sessions, currentSessionId };
}

function ensureSessionsFile() {
  if (fs.existsSync(SESSIONS_PATH)) return;
  const initial = normalizeSessionsStore({ sessions: [], currentSessionId: null });
  fs.writeFileSync(SESSIONS_PATH, `${JSON.stringify(initial, null, 2)}\n`, 'utf-8');
}

function loadSessionsStore() {
  ensureSessionsFile();
  try {
    const raw = readJson(SESSIONS_PATH);
    return normalizeSessionsStore(raw);
  } catch (_) {
    const fallback = normalizeSessionsStore({ sessions: [], currentSessionId: null });
    fs.writeFileSync(SESSIONS_PATH, `${JSON.stringify(fallback, null, 2)}\n`, 'utf-8');
    return fallback;
  }
}

function saveSessionsStore(input) {
  const normalized = normalizeSessionsStore(input);
  const text = `${JSON.stringify(normalized, null, 2)}\n`;
  const maxBytes = Number(process.env.SESSIONS_MAX_BYTES || 0);
  if (maxBytes > 0 && Buffer.byteLength(text, 'utf-8') > maxBytes) {
    throw new Error(`会话数据过大，超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
  }
  fs.writeFileSync(SESSIONS_PATH, text, 'utf-8');
  return normalized;
}

function saveConfig(config) {
  const normalized = validateConfig(config);
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  return normalized;
}

function getPublicConfig() {
  const config = loadConfig();
  return {
    appName: config.appName,
    backgroundImage: config.backgroundImage,
    defaultPresetId: config.defaultPresetId,
    presets: config.presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      model: preset.model,
      imageModel: preset.imageModel || ''
    }))
  };
}

function toDataUrlFromBase64(base64, mime = 'image/png') {
  const raw = String(base64 || '').trim();
  if (!raw) return '';
  return `data:${mime};base64,${raw}`;
}

function findFirstImageResult(value) {
  if (!value || typeof value !== 'object') return {};

  const directUrl = value.url || value.image_url || value.imageUrl;
  const directB64 = value.b64_json || value.b64 || value.base64 || value.image_base64;
  if (directUrl || directB64) {
    return {
      ...value,
      url: typeof directUrl === 'string' ? directUrl : directUrl?.url,
      b64_json: directB64
    };
  }

  if (typeof value.data === 'string' && /^data:image\//i.test(value.data)) {
    return { ...value, url: value.data };
  }

  for (const key of ['data', 'images', 'output', 'content', 'choices', 'result', 'results']) {
    const child = value[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findFirstImageResult(item);
        if (found.url || found.b64_json) return found;
      }
    } else if (child && typeof child === 'object') {
      const found = findFirstImageResult(child);
      if (found.url || found.b64_json) return found;
    }
  }

  return {};
}

function findPresetById(id) {
  const config = loadConfig();
  return config.presets.find((preset) => preset.id === id);
}

function getExtByMime(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
  };
  return map[mime] || '';
}

function getMimeByExt(ext) {
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif'
  };
  return map[String(ext || '').toLowerCase()] || '';
}

function inferExtFromUrl(url) {
  try {
    const u = new URL(String(url || ''));
    const pathname = String(u.pathname || '');
    const ext = pathname.split('.').pop()?.toLowerCase() || '';
    return ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext) ? ext : '';
  } catch (_) {
    return '';
  }
}

function saveImageBuffer(buffer, extHint = 'png') {
  const ext = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(String(extHint || '').toLowerCase())
    ? String(extHint).toLowerCase()
    : 'png';
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const filepath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return filename;
}

async function persistRemoteImage(remoteUrl) {
  const upstream = await fetch(remoteUrl);
  if (!upstream.ok) {
    throw new Error(`拉取上游图片失败 HTTP ${upstream.status}`);
  }

  const arr = await upstream.arrayBuffer();
  const buffer = Buffer.from(arr);
  if (!buffer.length) {
    throw new Error('上游图片为空');
  }

  const maxBytes = Number(process.env.IMAGE_MAX_BYTES || 32 * 1024 * 1024);
  if (buffer.length > maxBytes) {
    throw new Error(`上游图片过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
  }

  const contentType = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const extByMime = getExtByMime(contentType);
  const extByUrl = inferExtFromUrl(remoteUrl);
  const ext = extByMime || extByUrl || 'png';
  return saveImageBuffer(buffer, ext);
}

function getPublicBaseUrl(req) {
  const fromEnv = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || '');
  if (fromEnv) return fromEnv;

  const proto = req.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim() || req.protocol;
  const host = req.headers['x-forwarded-host']?.toString().split(',')[0]?.trim() || req.get('host');
  return normalizeBaseUrl(`${proto}://${host}`);
}

function createImageTask() {
  const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const task = {
    id,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    details: null,
    abortController: new AbortController()
  };
  imageTasks.set(id, task);
  return task;
}

function serializeImageTask(task) {
  if (!task) return null;
  return {
    ok: task.status === 'succeeded',
    taskId: task.id,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    result: task.result,
    error: task.error,
    details: task.details
  };
}

function cleanupImageTasks() {
  const now = Date.now();
  for (const [id, task] of imageTasks.entries()) {
    if (now - (task.finishedAt || task.updatedAt || task.createdAt) > IMAGE_TASK_TTL_MS) {
      imageTasks.delete(id);
    }
  }
}

setInterval(cleanupImageTasks, IMAGE_TASK_CLEANUP_MS).unref?.();

function toAbsoluteImageUrl(imageUrl, req) {
  const value = String(imageUrl || '').trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/uploads/')) return `${getPublicBaseUrl(req)}${value}`;
  return value;
}

function normalizeUpstreamMessages(messages, req) {
  return messages.map((msg) => {
    if (!Array.isArray(msg?.content)) return msg;

    return {
      ...msg,
      content: msg.content.map((part) => {
        if (!part || part.type !== 'image_url') return part;

        if (typeof part.image_url === 'string') {
          return { ...part, image_url: toAbsoluteImageUrl(part.image_url, req) };
        }

        if (part.image_url && typeof part.image_url === 'object') {
          return {
            ...part,
            image_url: {
              ...part.image_url,
              url: toAbsoluteImageUrl(part.image_url.url, req)
            }
          };
        }

        return part;
      })
    };
  });
}

function saveBase64Image(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/i);
  if (!match) {
    throw new Error('图片格式无效，仅支持 png/jpeg/webp/gif');
  }

  const mime = match[1].toLowerCase();
  const ext = getExtByMime(mime);
  const raw = match[3];
  const buffer = Buffer.from(raw, 'base64');

  if (!buffer.length) {
    throw new Error('图片内容为空');
  }

  const maxBytes = 8 * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw new Error('图片过大，压缩后仍超过 8MB');
  }

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const filepath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return filename;
}

function buildSystemMessage() {
  const timeStr = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  return {
    role: 'system',
    content: `当前北京时间：${timeStr}。请基于此回答。`
  };
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: '服务端未配置 EASYCHAT_ADMIN_PASSWORD，服务不可用'
    });
  }

  const password = req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '管理密码错误' });
  }

  next();
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', requireAdmin, (req, res) => {
  try {
    res.json(getPublicConfig());
  } catch (error) {
    writeLog('ERROR', '读取公开配置失败', { message: error.message });
    res.status(500).json({ error: error.message || '读取配置失败' });
  }
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  try {
    res.json(loadConfig());
  } catch (error) {
    writeLog('ERROR', '读取管理配置失败', { message: error.message });
    res.status(500).json({ error: error.message || '读取配置失败' });
  }
});

app.put('/api/admin/config', requireAdmin, (req, res) => {
  try {
    const saved = saveConfig(req.body || {});
    res.json({ ok: true, config: saved });
  } catch (error) {
    writeLog('ERROR', '保存管理配置失败', { message: error.message });
    res.status(400).json({ error: error.message || '保存配置失败' });
  }
});

app.get('/api/sessions', requireAdmin, (req, res) => {
  try {
    const store = loadSessionsStore();
    return res.json({ ok: true, ...store });
  } catch (error) {
    writeLog('ERROR', '读取会话存储失败', { message: error.message });
    return res.status(500).json({ ok: false, error: error.message || '读取会话失败' });
  }
});

app.put('/api/sessions', requireAdmin, (req, res) => {
  try {
    const { sessions, currentSessionId } = req.body || {};
    const saved = saveSessionsStore({ sessions, currentSessionId });
    return res.json({ ok: true, ...saved });
  } catch (error) {
    writeLog('ERROR', '保存会话存储失败', { message: error.message });
    return res.status(400).json({ ok: false, error: error.message || '保存会话失败' });
  }
});

app.post('/api/test', requireAdmin, async (req, res) => {
  try {
    const { presetId } = req.body || {};
    const preset = findPresetById(presetId);

    if (!preset) {
      return res.status(400).json({ error: '无效的 presetId' });
    }

    const url = `${normalizeBaseUrl(preset.baseUrl)}/chat/completions`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: buildUpstreamHeaders(preset.apiKey),
      body: JSON.stringify({
        model: preset.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false
      })
    });

    const text = await upstream.text();

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok: false,
        status: upstream.status,
        message: text
      });
    }

    return res.json({
      ok: true,
      status: upstream.status
    });
  } catch (error) {
    writeLog('ERROR', '测试预设连通性失败', { message: error.message });
    return res.status(500).json({
      ok: false,
      error: error.message || '测试失败'
    });
  }
});

app.post('/api/upload-image', requireAdmin, (req, res) => {
  try {
    const { dataUrl } = req.body || {};
    if (!dataUrl) {
      return res.status(400).json({ error: '缺少 dataUrl' });
    }

    const filename = saveBase64Image(dataUrl);
    const relativeUrl = `/uploads/${filename}`;
    const absoluteUrl = `${getPublicBaseUrl(req)}${relativeUrl}`;
    return res.json({ ok: true, url: absoluteUrl, relativeUrl });
  } catch (error) {
    writeLog('ERROR', '上传图片失败', { message: error.message });
    return res.status(400).json({
      ok: false,
      error: error.message || '上传图片失败'
    });
  }
});

app.post('/api/chat', requireAdmin, async (req, res) => {
  try {
    const { presetId, messages = [], stream = true } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages 不能为空' });
    }

    const preset = findPresetById(presetId);
    if (!preset) {
      return res.status(400).json({ error: '无效的 presetId' });
    }

    const url = `${normalizeBaseUrl(preset.baseUrl)}/chat/completions`;
    const upstreamMessages = normalizeUpstreamMessages(messages, req);

    const upstream = await fetch(url, {
      method: 'POST',
      headers: buildUpstreamHeaders(preset.apiKey),
      body: JSON.stringify({
        model: preset.model,
        messages: [buildSystemMessage(), ...upstreamMessages],
        stream: Boolean(stream)
      })
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({
        error: '上游接口返回错误',
        details: text
      });
    }

    if (!stream) {
      const data = await upstream.json();
      return res.json(data);
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    if (!upstream.body) {
      return res.status(500).end('上游无响应流');
    }

    for await (const chunk of upstream.body) {
      res.write(chunk);
    }

    res.end();
  } catch (error) {
    writeLog('ERROR', '聊天请求失败', { message: error.message });
    if (!res.headersSent) {
      res.status(500).json({
        error: error.message || '服务异常'
      });
    } else {
      res.end();
    }
  }
});

async function generateImageResult(input, publicBaseUrl, signal) {
    const { presetId, prompt, size, quality, n, fallbackSizes } = input || {};
    const cleanPrompt = String(prompt || '').trim();

    if (!cleanPrompt) {
      const error = new Error('prompt 不能为空');
      error.status = 400;
      throw error;
    }

    const preset = findPresetById(presetId);
    if (!preset) {
      const error = new Error('无效的 presetId');
      error.status = 400;
      throw error;
    }

    const url = `${normalizeBaseUrl(preset.baseUrl)}/images/generations`;
    const model = String(preset.imageModel || preset.model || '').trim();
    if (!model) {
      const error = new Error('当前预设缺少可用模型（model/imageModel）');
      error.status = 400;
      throw error;
    }

    const requestedSize = normalizeImageSize(size);
    const fallbackList = uniqueNonEmptyStrings(
      (Array.isArray(fallbackSizes) ? fallbackSizes : DEFAULT_IMAGE_FALLBACK_SIZES)
        .map((item) => normalizeImageSize(item))
        .filter(Boolean)
    );
    const sizeAttempts = uniqueNonEmptyStrings([requestedSize, ...fallbackList].filter(Boolean));

    let lastStatus = 500;
    let lastDetails = null;

    writeLog('INFO', '图片生成请求', {
      presetId: preset.id,
      presetName: preset.name,
      chatModel: preset.model,
      imageModel: preset.imageModel || '',
      model,
      requestedSize: requestedSize || 'default',
      fallbackSizes: fallbackList
    });

    sizeAttemptLoop:
    for (let index = 0; index < Math.max(sizeAttempts.length, 1); index += 1) {
      const trySize = sizeAttempts[index] || '';

      for (let sizeAttempt = 1; sizeAttempt <= IMAGE_SAME_SIZE_RETRIES; sizeAttempt += 1) {

        let upstream = null;
        let text = '';
        let data = null;
        const payloadVariants = [true, false];

        for (const includeResponseFormat of payloadVariants) {
          const payload = {
            model,
            prompt: cleanPrompt
          };

          // 不同 OpenAI 兼容网关对 response_format 支持不一致：
          // 官方 DALL·E 需要/支持 url，部分中转或 Gemini 兼容层会直接报 unsupported parameter。
          if (includeResponseFormat) payload.response_format = 'url';
          if (trySize) payload.size = trySize;
          if (quality) payload.quality = String(quality);
          if (Number.isInteger(n) && n > 0 && n <= 4) payload.n = n;

          upstream = await fetch(url, {
            method: 'POST',
            headers: buildUpstreamHeaders(preset.apiKey),
            signal,
            body: JSON.stringify(payload)
          });

          text = await upstream.text();
          data = null;
          try {
            data = JSON.parse(text);
          } catch (_) {}

          if (upstream.ok || !includeResponseFormat || !isUnsupportedImagePayloadError(upstream.status, data || text)) {
            break;
          }

          writeLog('INFO', '图片生成移除 response_format 后重试', {
            model,
            size: trySize || 'default',
            status: upstream.status
          });
        }

        if (!upstream.ok) {
          lastStatus = upstream.status;
          lastDetails = data || text;

          writeLog('INFO', '图片生成上游返回错误', {
            model,
            size: trySize || 'default',
            attempt: `${sizeAttempt}/${IMAGE_SAME_SIZE_RETRIES}`,
            status: upstream.status,
            details: stringifyErrorDetails(lastDetails).slice(0, 1000)
          });

          if (sizeAttempt < IMAGE_SAME_SIZE_RETRIES && isTransientImageFailure(upstream.status, lastDetails)) {
            writeLog('INFO', '图片生成同尺寸重试', {
              model,
              size: trySize || 'default',
              nextAttempt: `${sizeAttempt + 1}/${IMAGE_SAME_SIZE_RETRIES}`,
              status: upstream.status
            });
            continue;
          }

          if (index < sizeAttempts.length - 1) {
            writeLog('INFO', '图片生成尺寸降级重试', {
              model,
              fromSize: trySize || 'default',
              toSize: sizeAttempts[index + 1],
              status: upstream.status
            });
            continue sizeAttemptLoop;
          }

          const error = new Error('上游图片接口返回错误');
          error.status = upstream.status;
          error.details = data || text;
          throw error;
        }

        const first = findFirstImageResult(data);
        const upstreamModel = String(data?.model || first?.model || '').trim();
        const firstUrl = String(first.url || '').trim();
        const firstB64 = String(first.b64_json || '').trim();
        const firstMime = String(first.mime_type || first.mime || '').trim().toLowerCase() || 'image/png';
        let imageUrl = firstUrl || toDataUrlFromBase64(firstB64, firstMime);

        if (!imageUrl) {
          lastStatus = 502;
          lastDetails = data || text;

          writeLog('INFO', '图片结果为空', {
            model,
            size: trySize || 'default',
            attempt: `${sizeAttempt}/${IMAGE_SAME_SIZE_RETRIES}`,
            responsePreview: stringifyErrorDetails(lastDetails).slice(0, 1500)
          });

          if (sizeAttempt < IMAGE_SAME_SIZE_RETRIES && isTransientImageFailure(lastStatus, lastDetails)) {
            writeLog('INFO', '图片结果为空，先同尺寸重试', {
              model,
              size: trySize || 'default',
              nextAttempt: `${sizeAttempt + 1}/${IMAGE_SAME_SIZE_RETRIES}`
            });
            continue;
          }

          if (index < sizeAttempts.length - 1) {
            writeLog('INFO', '图片结果为空，尝试降级尺寸重试', {
              model,
              fromSize: trySize || 'default',
              toSize: sizeAttempts[index + 1]
            });
            continue sizeAttemptLoop;
          }

          const error = new Error('上游未返回有效图片数据');
          error.status = 502;
          error.details = data || text;
          throw error;
        }

        if (firstUrl && /^https?:\/\//i.test(firstUrl)) {
          try {
            const savedFilename = await persistRemoteImage(firstUrl);
            imageUrl = `${publicBaseUrl}/uploads/${savedFilename}`;
          } catch (persistError) {
            writeLog('INFO', '图片持久化失败，回退使用上游直链', {
              message: persistError.message
            });
          }
        } else if (firstB64) {
          try {
            const ext = getExtByMime(firstMime) || 'png';
            const buffer = Buffer.from(firstB64, 'base64');
            if (buffer.length) {
              const savedFilename = saveImageBuffer(buffer, ext);
              imageUrl = `${publicBaseUrl}/uploads/${savedFilename}`;
            }
          } catch (persistError) {
            writeLog('INFO', 'base64 图片持久化失败，回退 data url', {
              message: persistError.message
            });
          }
        }

        return {
          ok: true,
          model,
          upstreamModel,
          prompt: cleanPrompt,
          url: imageUrl,
          revisedPrompt: first.revised_prompt || '',
          sizeUsed: trySize || '',
          fallbackApplied: index > 0
        };
      }
    }

    const error = new Error('生成图片失败');
    error.status = lastStatus || 500;
    error.details = lastDetails || '未知错误';
    throw error;
}

async function runImageTask(task, input, publicBaseUrl) {
  if (task.status === 'cancelled') return;
  task.status = 'running';
  task.startedAt = Date.now();
  task.updatedAt = task.startedAt;

  try {
    task.result = await generateImageResult(input, publicBaseUrl, task.abortController?.signal);
    if (task.status === 'cancelled') return;
    task.status = 'succeeded';
    task.finishedAt = Date.now();
    task.updatedAt = task.finishedAt;
    writeLog('INFO', '图片异步任务完成', { taskId: task.id, model: task.result?.model, sizeUsed: task.result?.sizeUsed || 'default' });
  } catch (error) {
    if (error.name === 'AbortError' || task.abortController?.signal?.aborted || task.status === 'cancelled') {
      task.status = 'cancelled';
      task.error = '图片生成已取消';
      task.details = null;
      task.finishedAt = Date.now();
      task.updatedAt = task.finishedAt;
      writeLog('INFO', '图片异步任务已取消', { taskId: task.id });
      return;
    }
    task.status = 'failed';
    task.error = error.message || '生成图片失败';
    task.details = error.details || null;
    task.finishedAt = Date.now();
    task.updatedAt = task.finishedAt;
    writeLog('ERROR', '图片异步任务失败', { taskId: task.id, message: task.error, details: stringifyErrorDetails(task.details).slice(0, 1000) });
  }
}

app.post('/api/image-generate', requireAdmin, (req, res) => {
  try {
    const { prompt, presetId } = req.body || {};
    if (!String(prompt || '').trim()) {
      return res.status(400).json({ error: 'prompt 不能为空' });
    }
    if (!findPresetById(presetId)) {
      return res.status(400).json({ error: '无效的 presetId' });
    }

    const task = createImageTask();
    const publicBaseUrl = getPublicBaseUrl(req);

    setImmediate(() => {
      runImageTask(task, req.body || {}, publicBaseUrl);
    });

    return res.status(202).json({
      ok: true,
      async: true,
      taskId: task.id,
      status: task.status,
      pollUrl: `/api/image-generate/${task.id}`
    });
  } catch (error) {
    writeLog('ERROR', '创建图片异步任务失败', { message: error.message });
    return res.status(500).json({ error: error.message || '创建图片任务失败' });
  }
});

app.get('/api/image-generate/:taskId', requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const task = imageTasks.get(String(req.params.taskId || ''));
  if (!task) {
    return res.status(404).json({ ok: false, error: '图片任务不存在或已过期' });
  }
  return res.json(serializeImageTask(task));
});

app.delete('/api/image-generate/:taskId', requireAdmin, (req, res) => {
  const task = imageTasks.get(String(req.params.taskId || ''));
  if (!task) {
    return res.status(404).json({ ok: false, error: '图片任务不存在或已过期' });
  }

  if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
    return res.json(serializeImageTask(task));
  }

  task.status = 'cancelled';
  task.error = '图片生成已取消';
  task.finishedAt = Date.now();
  task.updatedAt = task.finishedAt;
  task.abortController?.abort?.();
  writeLog('INFO', '收到图片任务取消请求', { taskId: task.id });
  return res.json(serializeImageTask(task));
});

app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(WEB_ROOT));

app.get('*', (req, res) => {
  res.sendFile(path.join(WEB_ROOT, 'index.html'));
});

app.listen(PORT, HOST, () => {
  writeLog('INFO', `EasyChat server running on http://${HOST}:${PORT}`);
  if (LOG_PATH) {
    writeLog('INFO', `Log persistence enabled: ${LOG_PATH}`);
  }
});

