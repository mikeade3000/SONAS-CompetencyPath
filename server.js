const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
  return longSteps.some((step) => stepLabel.includes(step)) ? 4500 : 2500;
}

function cleanJsonContent(raw) {
  return String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

async function openRouterRequest({ prompt, model, stepLabel, req }) {
  const apiKey = getServerApiKey();
  if (!apiKey) {
    const err = new Error('OPENROUTER_API_KEY is missing on the server.');
    err.status = 500;
    throw err;
  }

  const payload = {
    model: model || 'meta-llama/llama-3.3-70b-instruct',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.4,
    max_tokens: parseMaxTokens(stepLabel)
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'HTTP-Referer': getReferer(req),
    'X-Title': getAppTitle()
  };

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message =
          data?.error?.message ||
          data?.error ||
          `OpenRouter HTTP ${response.status}`;

        if ((response.status === 429 || response.status === 503) && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 4000));
          continue;
        }

        const err = new Error(message);
        err.status = response.status;
        throw err;
      }

      const raw = data?.choices?.[0]?.message?.content || '';
      const cleaned = cleanJsonContent(raw);

      try {
        return JSON.parse(cleaned);
      } catch (parseError) {
        const err = new Error(`Could not parse JSON for ${stepLabel || 'request'}.`);
        err.status = 502;
        throw err;
      }
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if ((error.name === 'AbortError' || String(error.message || '').includes('aborted')) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
        continue;
      }
      if (attempt < 3 && error.status && [429, 503].includes(error.status)) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 4000));
        continue;
      }
      break;
    }
  }

  throw lastError || new Error('OpenRouter request failed.');
}

function getHtmlEntryCandidates() {
  return [
    'index.html',
    'public/index.html',
    'CompetencyPath_OpenRouter_15_steps.html',
    'public/CompetencyPath_OpenRouter_15_steps.html',
    'CompetencyPath_15_steps.html',
    'public/CompetencyPath_15_steps.html'
  ];
}

app.get('/health', (_req, res) => {
  const htmlEntry = firstExisting(getHtmlEntryCandidates());
  res.json({
    ok: true,
    provider: 'openrouter',
    hasApiKey: Boolean(getServerApiKey()),
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct',
    app: getAppTitle(),
    htmlEntryFound: Boolean(htmlEntry),
    htmlEntryPath: htmlEntry ? path.relative(ROOT, htmlEntry) : null,
    rootFiles: fs.readdirSync(ROOT).filter((name) => !name.startsWith('.')).sort()
  });
});

app.post('/api/generate-step', async (req, res) => {
  try {
    const { prompt, model, stepLabel } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'A non-empty prompt is required.' });
    }

    const result = await openRouterRequest({
      prompt: prompt.trim(),
      model,
      stepLabel: stepLabel || 'AI generation step',
      req
    });

    return res.json(result);
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      error: error.message || 'Unexpected server error.'
    });
  }
});

app.use(express.static(ROOT, {
  extensions: ['html']
}));
app.use(express.static(path.join(ROOT, 'public'), {
  extensions: ['html']
}));

app.get('*', (req, res) => {
  const file = firstExisting(getHtmlEntryCandidates());

  if (!file) {
    return res.status(404).send('No HTML entry file found. Add index.html to the repo root or public/index.html.');
  }

  return res.sendFile(file);
});

app.listen(PORT, () => {
  console.log(`CompetencyPath OpenRouter server listening on port ${PORT}`);
});
