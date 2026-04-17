
const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));

function firstExisting(candidates) {
  for (const rel of candidates) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function resolveHtmlEntry() {
  return firstExisting([
    'public/index.html',
    'index.html',
    'public/CompetencyPath_OpenRouter_15_steps.html',
    'CompetencyPath_OpenRouter_15_steps.html',
    'public/CompetencyPath_15_steps.html',
    'CompetencyPath_15_steps.html'
  ]);
}

function getAppTitle() {
  return process.env.OPENROUTER_APP_NAME || 'CompetencyPath OpenRouter';
}

function getReferer(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function getServerApiKey() {
  return process.env.OPENROUTER_API_KEY || '';
}

function parseMaxTokens(stepLabel = '') {
  const longSteps = ['Step 8', 'Step 9', 'Step 11', 'Step 12', 'Step 13', 'Step 15'];
  return longSteps.some((step) => stepLabel.includes(step)) ? 3200 : 1800;
}

function cleanJsonContent(raw) {
  return String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractFirstJsonObject(raw) {
  const text = cleanJsonContent(raw);
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function buildMessages(prompt, mode) {
  const system = [
    'You are an expert competency-based curriculum designer for Kampala International University (KIU), Uganda.',
    'Return only valid JSON.',
    'Do not include markdown fences, prose, commentary, headings, or explanations outside JSON.'
  ].join(' ');

  const user =
    mode === 'json'
      ? `${prompt}\n\nReturn only a valid JSON object.`
      : `${prompt}\n\nIMPORTANT: Return only a single valid JSON object and nothing else.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

async function postToOpenRouter({ payload, headers }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timeout);
  }
}

function shouldRetryWithRelaxedMode(status, message) {
  const msg = String(message || '').toLowerCase();
  return (
    status === 400 ||
    status === 422 ||
    status === 502 ||
    status === 503 ||
    status === 529 ||
    msg.includes('provider returned error') ||
    msg.includes('no endpoints found') ||
    msg.includes('does not support') ||
    msg.includes('response_format') ||
    msg.includes('structured output') ||
    msg.includes('json mode')
  );
}

async function openRouterRequest({ prompt, stepLabel, req }) {
  const apiKey = getServerApiKey();
  if (!apiKey) {
    const err = new Error('OPENROUTER_API_KEY is missing on the server.');
    err.status = 500;
    throw err;
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': getReferer(req),
    'X-Title': getAppTitle()
  };

  const modes = ['json', 'relaxed'];
  let lastError = null;

  for (const mode of modes) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const payload = {
        model: OPENROUTER_MODEL,
        messages: buildMessages(prompt, mode),
        temperature: 0.2,
        max_tokens: parseMaxTokens(stepLabel),
        stream: false,
        provider: {
          sort: 'throughput',
          allow_fallbacks: true,
          require_parameters: mode === 'json'
        },
        plugins: [{ id: 'response-healing' }]
      };

      if (mode === 'json') {
        payload.response_format = { type: 'json_object' };
      }

      try {
        const { response, data } = await postToOpenRouter({ payload, headers });

        if (!response.ok) {
          const message =
            data?.error?.message ||
            data?.error ||
            data?.message ||
            `OpenRouter HTTP ${response.status}`;

          if ([429, 503, 529].includes(response.status) && attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 4000));
            continue;
          }

          if (mode === 'json' && shouldRetryWithRelaxedMode(response.status, message)) {
            lastError = new Error(message);
            lastError.status = response.status;
            break;
          }

          const err = new Error(message);
          err.status = response.status;
          throw err;
        }

        const raw = data?.choices?.[0]?.message?.content || '';
        const parsed = extractFirstJsonObject(raw);

        if (parsed && typeof parsed === 'object') {
          return parsed;
        }

        if (mode === 'json') {
          lastError = new Error(`Could not parse JSON for ${stepLabel || 'request'}.`);
          lastError.status = 502;
          break;
        }

        const err = new Error(`Could not parse AI response for ${stepLabel || 'request'}.`);
        err.status = 502;
        throw err;
      } catch (error) {
        lastError = error;

        const aborted =
          error?.name === 'AbortError' ||
          String(error?.message || '').toLowerCase().includes('aborted');

        if ((aborted || [429, 503, 529].includes(error?.status)) && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 4000));
          continue;
        }

        if (mode === 'json' && shouldRetryWithRelaxedMode(error?.status, error?.message)) {
          break;
        }

        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
          continue;
        }

        break;
      }
    }
  }

  throw lastError || new Error('OpenRouter request failed.');
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    provider: 'openrouter',
    model: OPENROUTER_MODEL,
    hasApiKey: Boolean(getServerApiKey()),
    htmlEntryFound: Boolean(resolveHtmlEntry()),
    app: getAppTitle()
  });
});

app.post('/api/generate-step', async (req, res) => {
  try {
    const { prompt, stepLabel } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'A non-empty prompt is required.' });
    }

    const result = await openRouterRequest({
      prompt: prompt.trim(),
      stepLabel: stepLabel || 'AI generation step',
      req
    });

    return res.json(result);
  } catch (error) {
    const status = error.status || 500;
    console.error('[generate-step]', {
      status,
      message: error.message,
      step: req.body?.stepLabel || 'unknown'
    });
    return res.status(status).json({
      error: error.message || 'Unexpected server error.'
    });
  }
});

const publicDir = path.join(ROOT, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, { extensions: ['html'] }));
}
app.use(express.static(ROOT, { extensions: ['html'] }));

app.get('*', (_req, res) => {
  const file = resolveHtmlEntry();
  if (!file) {
    return res.status(404).send('No HTML entry file found.');
  }
  return res.sendFile(file);
});

app.listen(PORT, () => {
  console.log(`CompetencyPath OpenRouter server listening on port ${PORT}`);
});
