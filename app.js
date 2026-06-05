// ══════════════════════════════════════════════════════════════
// app.js — Hoofd-state, UI-logica, pipeline
// Afhankelijkheden: i18n.js, parsers.js, ai.js
// ══════════════════════════════════════════════════════════════

// ── GLOBALE APP STATE ─────────────────────────────────────────
window.APP = {
  currentUILang:    'nl',
  currentMode:      'webllm',
  currentStyleLevel: 3,
  currentOutputLang: 'nl',
};

const LANG_CODES = {
  nl: 'Nederlands', en: 'English', de: 'Deutsch',
  es: 'Español',    zh: '中文',    pl: 'Polski',
};

let originalFilename = '';
let lastInputExt     = '';

// ── I18N TOEPASSEN ────────────────────────────────────────────
function applyI18N() {
  const T = I18N[APP.currentUILang] || I18N.nl;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (T[key] !== undefined) el.textContent = T[key];
  });

  document.querySelectorAll('.flag-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.uiLang === APP.currentUILang));

  // Slider labels
  const labels = T.slider_labels || [];
  document.getElementById('slider-labels').innerHTML =
    labels.map(l => `<span>${l}</span>`).join('');
  updateSliderDisplay(APP.currentStyleLevel, false);

  // Mode tab lokale tekst
  const localTab = document.querySelector('[data-mode="webllm"]');
  if (localTab) localTab.textContent = T.mode_local;

  buildLangGrid();
}

function buildLangGrid() {
  const T    = I18N[APP.currentUILang] || I18N.nl;
  const grid = document.getElementById('lang-grid');
  grid.innerHTML = '';
  (T.output_langs || []).forEach(({ code, label }) => {
    const btn = document.createElement('button');
    btn.className    = 'lang-btn' + (code === APP.currentOutputLang ? ' active' : '');
    btn.dataset.lang = code;
    btn.textContent  = label;
    btn.onclick      = () => setLang(btn);
    grid.appendChild(btn);
  });
}

// ── UI EVENT HANDLERS ─────────────────────────────────────────
function setUILang(lang) {
  APP.currentUILang = lang;
  const T     = I18N[lang] || I18N.nl;
  const codes = (T.output_langs || []).map(l => l.code);
  if (codes.includes(lang)) APP.currentOutputLang = lang;
  applyI18N();
}

function setMode(mode) {
  APP.currentMode = mode;
  document.querySelectorAll('.mode-tab').forEach(tab =>
    tab.classList.toggle('active', tab.dataset.mode === mode));
  document.getElementById('webllm-section').classList.toggle('visible', mode === 'webllm');
  document.getElementById('openrouter-section').classList.toggle('visible', mode === 'openrouter');
  document.getElementById('ppq-section').classList.toggle('visible', mode === 'ppq');
}

function updateSliderDisplay(val, updateState = true) {
  if (updateState) APP.currentStyleLevel = parseInt(val);
  const T      = I18N[APP.currentUILang] || I18N.nl;
  const labels = T.slider_labels || [];
  const idx    = (parseInt(val) || 3) - 1;
  document.getElementById('slider-display').textContent = labels[idx] || '';
}

function setLang(btn) {
  document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  APP.currentOutputLang = btn.dataset.lang;
}

// ── TOAST & LOG ───────────────────────────────────────────────
function showToast(msg, type = '') {
  const toast   = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = 'show ' + type;
  setTimeout(() => toast.className = '', 3500);
}

function log(msg) {
  const box = document.getElementById('log-box');
  box.innerHTML += `<div>${new Date().toLocaleTimeString()} — ${msg}</div>`;
  box.scrollTop = box.scrollHeight;
}

function setProgress(pct) {
  document.getElementById('progress-bar').style.width = pct + '%';
}

function renderSteps(activeId = null, doneIds = [], errorId = null) {
  const T      = I18N[APP.currentUILang] || I18N.nl;
  const labels = T.steps || [];
  const ids    = ['parse', 'extract', 'ai', 'rebuild', 'pack'];
  const icons  = ['📖', '📝', '🤖', '🔧', '📦'];

  document.getElementById('steps-container').innerHTML = ids.map((id, i) => {
    let cls  = 'step';
    let icon = icons[i];
    if (doneIds.includes(id))  { cls += ' done';       icon = '✅'; }
    else if (id === errorId)   { cls += ' error-step'; icon = '❌'; }
    else if (id === activeId)  { cls += ' active';     icon = `<span class="spinner"></span>`; }
    return `<div class="${cls}">
      <span class="step-icon">${icon}</span>
      <span class="step-label">${labels[i] || id}</span>
    </div>`;
  }).join('');
}

// ── WEBGPU TEST ───────────────────────────────────────────────
async function testWebGPU() {
  const el = document.getElementById('webgpu-result');
  if (!navigator.gpu) {
    el.innerHTML   = `❌ ${t('webgpu_no')}`;
    el.style.color = 'var(--error)';
    return;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No adapter');
    el.innerHTML   = `✅ ${t('webgpu_ok')}: <strong>${adapter.name || '?'}</strong>`;
    el.style.color = 'var(--success)';
  } catch (e) {
    el.innerHTML   = `❌ ${t('webgpu_err')}: ${e.message}`;
    el.style.color = 'var(--error)';
  }
}

// ── RESET ─────────────────────────────────────────────────────
function resetApp() {
  ['progress-card', 'download-card'].forEach(id =>
    document.getElementById(id).classList.remove('visible'));
  ['upload-card', 'ai-card', 'style-card', 'lang-card'].forEach(id =>
    document.getElementById(id).style.display = '');
  document.getElementById('log-box').innerHTML   = '';
  document.getElementById('stats-row').innerHTML = '';
  document.getElementById('download-link-alt').style.display = 'none';
  setProgress(0);
  resetCostState();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── DROP ZONE ─────────────────────────────────────────────────
function initDropZone() {
  const dropzone  = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });
}

// ── HOOFD PIPELINE ────────────────────────────────────────────
async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['epub', 'html', 'htm', 'pdf', 'vtt', 'srt'].includes(ext)) {
    showToast('❌ ' + t('toast_invalid'), 'error');
    return;
  }

  // Valideer API-sleutels
  if (APP.currentMode === 'openrouter') {
    const key = document.getElementById('openrouter-key').value.trim();
    if (!key) { showToast('❌ ' + t('toast_no_or_key'), 'error'); return; }
    sessionStorage.setItem('or_key', key);
  }
  if (APP.currentMode === 'ppq') {
    const key = document.getElementById('ppq-key').value.trim();
    if (!key) { showToast('❌ ' + t('toast_no_ppq_key'), 'error'); return; }
    sessionStorage.setItem('ppq_key', key);
  }

  originalFilename = file.name.replace(/\.[^.]+$/, '');
  lastInputExt     = ext;

  ['upload-card', 'ai-card', 'style-card', 'lang-card'].forEach(id =>
    document.getElementById(id).style.display = 'none');

  document.getElementById('progress-card').classList.add('visible');
  renderSteps(); setProgress(0);
  resetCostState();

  try {
    // ── Saldo ophalen vóór verwerking (PPQ.ai) ──
    if (APP.currentMode === 'ppq') {
      const key = sessionStorage.getItem('ppq_key') ||
                  document.getElementById('ppq-key').value.trim();
      costState.balanceBefore = await fetchPPQBalance(key);
      if (costState.balanceBefore !== null)
        log(`💰 PPQ.ai ${t('cost_balance_before')} $${parseFloat(costState.balanceBefore).toFixed(4)}`);
    }

    // ── STAP 1: Parse ──
    renderSteps('parse', []);
    log(`${t('log_loaded')}: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
    log(`${t('log_style')}: ${(I18N[APP.currentUILang].slider_labels || [])[APP.currentStyleLevel - 1]} | ${t('log_lang')}: ${LANG_CODES[APP.currentOutputLang] || APP.currentOutputLang}`);

    let parts    = [];
    let epubZip  = null;
    let epubMeta = {};

    if (ext === 'epub') {
      ({ parts, zip: epubZip, meta: epubMeta } = await parseEpub(file));
    } else if (ext === 'html' || ext === 'htm') {
      parts    = await parseHtml(file);
      epubMeta = { title: file.name, author: '' };
    } else if (ext === 'pdf') {
      parts    = await parsePdf(file);
      epubMeta = { title: file.name, author: '' };
    } else if (ext === 'vtt') {
      parts    = await parseVTT(file);
      epubMeta = { title: file.name, author: '' };
    } else if (ext === 'srt') {
      parts    = await parseSRT(file);
      epubMeta = { title: file.name, author: '' };
    }

    log(`✅ ${parts.length} ${t('log_chapters')}`);
    renderSteps('extract', ['parse']); setProgress(15);
    await sleep(300);

    // ── STAP 3: AI hertaling ──
    renderSteps('ai', ['parse', 'extract']); setProgress(20);
    log(`🤖 ${t('log_start_ai')} ${APP.currentMode}…`);

    if (APP.currentMode === 'webllm' && !webllmEngine) {
      log(t('log_loading_model'));
      const modelId = document.getElementById('webllm-model').value;
      await loadWebLLM(modelId, text => log(`⬇️ ${text}`));
      log(t('log_model_ready'));
    }

    const systemPrompt = buildSystemPrompt(APP.currentStyleLevel, APP.currentOutputLang);

    for (let i = 0; i < parts.length; i++) {
      log(`${t('log_part')} ${i + 1}/${parts.length}…`);
      parts[i].modernText = await modernizePart(parts[i], ext, systemPrompt);
      setProgress(20 + Math.round((i + 1) / parts.length * 55));
    }

    // ── STAP 4 & 5: Herbouwen ──
    renderSteps('rebuild', ['parse', 'extract', 'ai']); setProgress(78);
    log(t('log_rebuild'));

    let primaryBlob, primaryExt, altBlob, altExt;

    if (ext === 'epub' && epubZip) {
      primaryBlob = await rebuildEpub(epubZip, parts, epubMeta);
      primaryExt  = 'epub';
    } else if (ext === 'vtt' || ext === 'srt') {
      primaryBlob = new Blob([buildVTT(parts)], { type: 'text/vtt' });
      primaryExt  = 'vtt';
      altBlob     = new Blob([buildSRT(parts)], { type: 'text/plain' });
      altExt      = 'srt';
    } else {
      primaryBlob = await buildEpubFromParts(parts, epubMeta, APP.currentOutputLang);
      primaryExt  = 'epub';
    }

    renderSteps('pack', ['parse', 'extract', 'ai', 'rebuild']); setProgress(92);
    await sleep(300);
    renderSteps(null, ['parse', 'extract', 'ai', 'rebuild', 'pack']); setProgress(100);

    // ── Saldo ophalen ná verwerking (PPQ.ai) ──
    if (APP.currentMode === 'ppq') {
      const key = sessionStorage.getItem('ppq_key') ||
                  document.getElementById('ppq-key').value.trim();
      costState.balanceAfter = await fetchPPQBalance(key);
      showBalanceRow(costState.balanceBefore, costState.balanceAfter);
    }

    log(t('log_done'));
    showDownload(primaryBlob, primaryExt, altBlob, altExt, parts);

  } catch (err) {
    console.error(err);
    log(`❌ ${err.message}`);
    showToast(`❌ ${t('toast_error')}: ${err.message}`, 'error');
  }
}

// ── DOWNLOAD TONEN ────────────────────────────────────────────
function showDownload(primaryBlob, primaryExt, altBlob, altExt, parts) {
  document.getElementById('progress-card').classList.remove('visible');
  document.getElementById('download-card').classList.add('visible');

  const link    = document.getElementById('download-link');
  link.href     = URL.createObjectURL(primaryBlob);
  link.download = `${originalFilename}_modern.${primaryExt}`;

  const altLink = document.getElementById('download-link-alt');
  if (altBlob) {
    altLink.style.display = 'inline-flex';
    altLink.href          = URL.createObjectURL(altBlob);
    altLink.download      = `${originalFilename}_modern.${altExt}`;
  } else {
    altLink.style.display = 'none';
  }

  const totalWords = parts.reduce((s, p) => s + (p.rawText?.split(/\s+/).length || 0), 0);
  const T          = I18N[APP.currentUILang] || I18N.nl;
  const isApi      = APP.currentMode !== 'webllm';

  document.getElementById('stats-row').innerHTML = `
    <div class="stat">📄 <strong>${parts.length}</strong> ${lastInputExt === 'vtt' || lastInputExt === 'srt' ? 'cues' : 'parts'}</div>
    <div class="stat">📝 <strong>~${totalWords.toLocaleString()}</strong> words</div>
    <div class="stat">💾 <strong>${(primaryBlob.size / 1024).toFixed(0)} KB</strong></div>
    <div class="stat">🤖 <strong>${APP.currentMode === 'webllm' ? 'Local (WebGPU)' : APP.currentMode === 'openrouter' ? 'OpenRouter' : 'PPQ.ai'}</strong></div>
    <div class="stat">🌍 <strong>${LANG_CODES[APP.currentOutputLang] || APP.currentOutputLang}</strong></div>
    <div class="stat">🎚️ <strong>${(T.slider_labels || [])[APP.currentStyleLevel - 1] || ''}</strong></div>
    ${isApi ? `
    <div class="stat">💰 <strong>$${costState.costUsd.toFixed(6)}</strong> ${t('cost_stat')}</div>
    <div class="stat">🔢 <strong>${costState.totalTokens.toLocaleString()}</strong> tokens</div>
    ` : ''}
  `;

  showToast('✅ ' + t('toast_success'), 'success');
}

// ── INIT ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Herstel opgeslagen API-sleutels
  const orKey  = sessionStorage.getItem('or_key');
  const ppqKey = sessionStorage.getItem('ppq_key');
  if (orKey)  document.getElementById('openrouter-key').value = orKey;
  if (ppqKey) document.getElementById('ppq-key').value        = ppqKey;

  // PDF.js worker
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  initDropZone();
  applyI18N();
});
