// ══════════════════════════════════════════════════════════════
// ai.js — WebLLM, API-calls (OpenRouter / PPQ.ai), kosten-tracking
// ══════════════════════════════════════════════════════════════

// ── KOSTEN STATE ──────────────────────────────────────────────
const costState = {
  inputTokens:   0,
  outputTokens:  0,
  totalTokens:   0,
  costUsd:       0,
  balanceBefore: null,
  balanceAfter:  null,
};

function resetCostState() {
  costState.inputTokens   = 0;
  costState.outputTokens  = 0;
  costState.totalTokens   = 0;
  costState.costUsd       = 0;
  costState.balanceBefore = null;
  costState.balanceAfter  = null;
  updateCostMeter();
  document.getElementById('cost-meter').classList.remove('visible');
  document.getElementById('balance-row').style.display = 'none';
}

function addCost(usage) {
  if (!usage) return;
  costState.inputTokens  += usage.prompt_tokens     || usage.input_tokens     || 0;
  costState.outputTokens += usage.completion_tokens || usage.output_tokens    || 0;
  costState.totalTokens  += usage.total_tokens      || 0;
  if (usage.cost !== undefined) costState.costUsd += parseFloat(usage.cost) || 0;
  updateCostMeter();
  document.getElementById('cost-meter').classList.add('visible');
}

function updateCostMeter() {
  document.getElementById('cm-input-tokens').textContent  = costState.inputTokens.toLocaleString();
  document.getElementById('cm-output-tokens').textContent = costState.outputTokens.toLocaleString();
  document.getElementById('cm-total-tokens').textContent  = costState.totalTokens.toLocaleString();
  document.getElementById('cm-cost-usd').textContent      = '$' + costState.costUsd.toFixed(6);
}

async function fetchPPQBalance(apiKey) {
  try {
    const res = await fetch('https://api.ppq.ai/credits/balance', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.balance ?? data.credits ?? data.credit_balance ?? null;
  } catch { return null; }
}

function showBalanceRow(before, after) {
  if (before === null && after === null) return;
  const row = document.getElementById('balance-row');
  row.style.display = 'flex';
  const fmt = v => v !== null ? '$' + parseFloat(v).toFixed(4) : '—';
  document.getElementById('cm-balance-before').textContent = fmt(before);
  document.getElementById('cm-balance-after').textContent  = fmt(after);
  if (before !== null && after !== null) {
    const spent   = parseFloat(before) - parseFloat(after);
    const spentEl = document.getElementById('cm-balance-spent');
    spentEl.textContent = '$' + Math.abs(spent).toFixed(6);
    if (spent > 0) costState.costUsd = spent;
    updateCostMeter();
  }
}

// ── WEBLLM ────────────────────────────────────────────────────
let webllmEngine = null;

async function loadWebLLM(modelId, onProgress) {
  if (!navigator.gpu) throw new Error('WebGPU not available. Please choose an API mode.');

  if (!window.webllm) {
    await new Promise((resolve, reject) => {
      const s   = document.createElement('script');
      s.type    = 'module';
      s.textContent = `
        import * as webllm from 'https://esm.run/@mlc-ai/web-llm';
        window.webllm = webllm;
        window.dispatchEvent(new Event('webllm-loaded'));
      `;
      document.head.appendChild(s);
      window.addEventListener('webllm-loaded', resolve, { once: true });
      setTimeout(() => reject(new Error('WebLLM load timeout')), 90000);
    });
  }

  webllmEngine = await window.webllm.CreateMLCEngine(modelId, {
    initProgressCallback: report => onProgress && onProgress(report.text),
  });
}

// ── SYSTEM PROMPT BUILDER ─────────────────────────────────────
function buildSystemPrompt(styleLevel, outputLang) {
  const T         = I18N[window.APP?.currentUILang] || I18N.nl;
  const styleHint = (T.style_hints || [])[styleLevel - 1] || '';
  const langNames = { nl:'Nederlands', en:'English', de:'Deutsch',
                      es:'Español', zh:'中文', pl:'Polski' };
  const langName  = langNames[outputLang] || outputLang;
  const isTransl  = outputLang !== 'nl';

  return `You are an expert text editor specialising in modernising archaic Dutch text.
Rewrite the given text according to these instructions:

STYLE: ${styleHint}

OUTPUT LANGUAGE: Write the entire output in ${langName}.${isTransl
    ? `\nTranslate from (archaic) Dutch into ${langName}.` : ''}

RULES:
- Preserve ALL meaning and content
- Keep names, titles and place names${isTransl ? ' (transliterate where conventional)' : ' unchanged'}
- Preserve paragraph structure
- Return ONLY the rewritten text, no explanations or comments`;
}

// ── MODERNISERING DISPATCHER ──────────────────────────────────
async function modernizePart(part, inputType, systemPrompt) {
  // Subtitles: vertaal per cue (korte tekst, geen chunking)
  if (inputType === 'vtt' || inputType === 'srt') {
    return await callAI(part.rawText, systemPrompt);
  }

  // EPUB / HTML / PDF: splits in chunks van max 1200 woorden
  const chunks       = splitIntoChunks(part.rawText, 1200);
  const modernChunks = [];
  for (const chunk of chunks) {
    if (chunk.trim().length < 20) { modernChunks.push(chunk); continue; }
    modernChunks.push(await callAI(chunk, systemPrompt));
  }
  const modernText = modernChunks.join('\n\n');
  return injectModernTextIntoHtml(part.html, part.rawText, modernText);
}

function splitIntoChunks(text, maxWords) {
  const words  = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords)
    chunks.push(words.slice(i, i + maxWords).join(' '));
  return chunks;
}

async function callAI(text, systemPrompt) {
  const mode = window.APP?.currentMode || 'webllm';
  if (mode === 'webllm')     return callWebLLM(text, systemPrompt);
  // if (mode === 'openrouter') return callOpenRouter(text, systemPrompt);
  if (mode === 'ppq')        return callPPQ(text, systemPrompt);
  throw new Error('Unknown AI mode');
}

// ── WEBLLM CALL ───────────────────────────────────────────────
async function callWebLLM(text, systemPrompt) {
  if (!webllmEngine) throw new Error('WebLLM not loaded');
  const reply = await webllmEngine.chat.completions.create({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `Rewrite this text:\n\n${text}` },
    ],
    temperature: 0.3,
    max_tokens:  2048,
  });
  // WebLLM heeft geen kosten, maar telt wel tokens
  if (reply.usage) addCost(reply.usage);
  return reply.choices[0].message.content.trim();
}

// ── OPENROUTER CALL ───────────────────────────────────────────
async function callOpenRouter(text, systemPrompt) {
  const key   = sessionStorage.getItem('or_key') ||
                document.getElementById('openrouter-key').value.trim();
  const model = document.getElementById('openrouter-model').value;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Authorization':      `Bearer ${key}`,
      'Content-Type':       'application/json',
      'HTTP-Referer':       window.location.href,
      'X-OpenRouter-Title': 'Hertaler',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Rewrite this text:\n\n${text}` },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenRouter ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  addCost(data.usage); // usage.cost zit erin bij OpenRouter
  return data.choices[0].message.content.trim();
}

// ── PPQ.AI CALL ───────────────────────────────────────────────
async function callPPQ(text, systemPrompt) {
  const key   = sessionStorage.getItem('ppq_key') ||
                document.getElementById('ppq-key').value.trim();
  const model = document.getElementById('ppq-model').value;

  const res = await fetch('https://api.ppq.ai/chat/completions', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Rewrite this text:\n\n${text}` },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`PPQ.ai ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  addCost(data.usage); // usage.cost zit erin bij PPQ.ai
  return data.choices[0].message.content.trim();
}
