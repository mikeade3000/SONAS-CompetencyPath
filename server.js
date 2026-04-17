const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

const GROQ_ENDPOINT  = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_API_KEY   = process.env.GROQ_API_KEY;

// Cascade: if one model is rate-limited, immediately try the next
const MODEL_CASCADE = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama3-70b-8192',
  'llama3-8b-8192'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.get('/ping', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));
app.get('/',    (_req, res) => res.json({ status: 'ok', service: 'CompetencyPath API', ts: Date.now() }));

app.post('/api/generate-step', async (req, res) => {
  const { prompt, model, stepLabel } = req.body || {};
  if (!prompt)       return res.status(400).json({ error: 'prompt is required' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set on server' });

  const complexSteps = ['Step 4','Step 5','Step 7','Step 8'];
  const maxTokens    = complexSteps.some(s => (stepLabel||'').includes(s)) ? 4096 : 2048;

  // Build cascade: requested model first, then the rest
  const requested = MODEL_CASCADE.includes(model) ? model : MODEL_CASCADE[0];
  const cascade   = [requested, ...MODEL_CASCADE.filter(m => m !== requested)];

  // Total time budget: 80s (under Render's 90s request timeout)
  // Strategy: try each model once with a short wait on 429, then move on
  const deadline = Date.now() + 80000;

  for (const tryModel of cascade) {
    if (Date.now() >= deadline) break;

    try {
      const groqRes = await fetch(GROQ_ENDPOINT, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + GROQ_API_KEY
        },
        body: JSON.stringify({
          model:           tryModel,
          messages:        [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature:     0.7,
          max_tokens:      maxTokens
        }),
        signal: AbortSignal.timeout(25000) // 25s per Groq attempt
      });

      if (groqRes.ok) {
        const data    = await groqRes.json();
        const raw     = data?.choices?.[0]?.message?.content || '';
        const cleaned = raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
        try {
          return res.json(JSON.parse(cleaned));
        } catch {
          return res.status(502).json({ error: 'Model returned malformed JSON. Try a shorter write-up.' });
        }
      }

      const errData = await groqRes.json().catch(() => ({}));
      const msg     = errData?.error?.message || '';

      if (groqRes.status === 429) {
        // Rate limited — wait a short time then try NEXT model (don't wait a full minute)
        const retryAfter = parseInt(groqRes.headers.get('retry-after') || '0', 10);
        const waitMs = Math.min((retryAfter > 0 ? retryAfter : 8) * 1000, 20000); // max 20s wait
        console.log(`[${stepLabel}] ${tryModel} rate-limited. Waiting ${waitMs/1000}s then trying next model...`);
        if (Date.now() + waitMs < deadline) await sleep(waitMs);
        continue; // try next model
      }

      // Other errors — return immediately
      return res.status(groqRes.status).json({ error: msg || `Groq HTTP ${groqRes.status}` });

    } catch (err) {
      // Network/timeout error on this model — try next immediately
      console.warn(`[${stepLabel}] ${tryModel} error: ${err.message} — trying next model`);
      continue;
    }
  }

  // All models failed within time budget
  return res.status(429).json({
    error: 'All Groq models are currently rate-limited. Please wait 60 seconds and try again.'
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('CompetencyPath running on port ' + PORT));
