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
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'presets.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, 'presets.example.json');
const ADMIN_PASSWORD = process.env.EASYCHAT_ADMIN_PASSWORD || '';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

app.use(express.json({ limit: '10mb' }));

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
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

function getPublicBaseUrl(req) {
  const fromEnv = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || '');
  if (fromEnv) return fromEnv;

  const proto = req.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim() || req.protocol;
  const host = req.headers['x-forwarded-host']?.toString().split(',')[0]?.trim() || req.get('host');
  return normalizeBaseUrl(`${proto}://${host}`);
}

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
      error: '服务端未配置 EASYCHAT_ADMIN_PASSWORD，无法使用在线配置功能'
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

app.get('/api/config', (req, res) => {
  try {
    res.json(getPublicConfig());
  } catch (error) {
    res.status(500).json({ error: error.message || '读取配置失败' });
  }
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  try {
    res.json(loadConfig());
  } catch (error) {
    res.status(500).json({ error: error.message || '读取配置失败' });
  }
});

app.put('/api/admin/config', requireAdmin, (req, res) => {
  try {
    const saved = saveConfig(req.body || {});
    res.json({ ok: true, config: saved });
  } catch (error) {
    res.status(400).json({ error: error.message || '保存配置失败' });
  }
});

app.post('/api/test', async (req, res) => {
  try {
    const { presetId } = req.body || {};
    const preset = findPresetById(presetId);

    if (!preset) {
      return res.status(400).json({ error: '无效的 presetId' });
    }

    const url = `${normalizeBaseUrl(preset.baseUrl)}/chat/completions`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${preset.apiKey}`,
        'Content-Type': 'application/json'
      },
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
    return res.status(500).json({
      ok: false,
      error: error.message || '测试失败'
    });
  }
});

app.post('/api/upload-image', (req, res) => {
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
    return res.status(400).json({
      ok: false,
      error: error.message || '上传图片失败'
    });
  }
});

app.post('/api/chat', async (req, res) => {
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
      headers: {
        Authorization: `Bearer ${preset.apiKey}`,
        'Content-Type': 'application/json'
      },
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
    if (!res.headersSent) {
      res.status(500).json({
        error: error.message || '服务异常'
      });
    } else {
      res.end();
    }
  }
});

app.post('/api/image-generate', async (req, res) => {
  try {
    const { presetId, prompt, size, quality, n } = req.body || {};
    const cleanPrompt = String(prompt || '').trim();

    if (!cleanPrompt) {
      return res.status(400).json({ error: 'prompt 不能为空' });
    }

    const preset = findPresetById(presetId);
    if (!preset) {
      return res.status(400).json({ error: '无效的 presetId' });
    }

    const url = `${normalizeBaseUrl(preset.baseUrl)}/images/generations`;
    const model = String(preset.imageModel || preset.model || '').trim();
    if (!model) {
      return res.status(400).json({ error: '当前预设缺少可用模型（model/imageModel）' });
    }

    const payload = {
      model,
      prompt: cleanPrompt,
      response_format: 'url'
    };

    if (size) payload.size = String(size);
    if (quality) payload.quality = String(quality);
    if (Number.isInteger(n) && n > 0 && n <= 4) payload.n = n;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${preset.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {}

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: '上游图片接口返回错误',
        details: data || text
      });
    }

    const first = data?.data?.[0] || {};
    const imageUrl = first.url || toDataUrlFromBase64(first.b64_json);

    if (!imageUrl) {
      return res.status(502).json({
        error: '上游未返回有效图片数据',
        details: data || text
      });
    }

    return res.json({
      ok: true,
      model,
      prompt: cleanPrompt,
      url: imageUrl,
      revisedPrompt: first.revised_prompt || ''
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || '生成图片失败'
    });
  }
});

app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(WEB_ROOT));

app.get('*', (req, res) => {
  res.sendFile(path.join(WEB_ROOT, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`EasyChat server running on http://${HOST}:${PORT}`);
});

