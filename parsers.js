// ══════════════════════════════════════════════════════════════
// parsers.js — Inlezen & schrijven van EPUB / HTML / PDF / VTT / SRT
// Afhankelijkheden: JSZip (global), pdfjsLib (global)
// ══════════════════════════════════════════════════════════════

// ── EPUB ──────────────────────────────────────────────────────
async function parseEpub(file) {
  const zip    = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();
  const parts  = [];
  const meta   = {};

  const containerXml = await zip.file('META-INF/container.xml').async('string');
  const rootfilePath = parser
    .parseFromString(containerXml, 'application/xml')
    .querySelector('rootfile')
    ?.getAttribute('full-path');
  if (!rootfilePath) throw new Error('No rootfile found in EPUB');

  const opfContent = await zip.file(rootfilePath).async('string');
  const opfDoc     = parser.parseFromString(opfContent, 'application/xml');
  const opfDir     = rootfilePath.includes('/')
    ? rootfilePath.substring(0, rootfilePath.lastIndexOf('/') + 1)
    : '';

  meta.title   = opfDoc.querySelector('metadata > title, metadata > dc\\:title')
    ?.textContent?.trim() || '';
  meta.author  = opfDoc.querySelector('metadata > creator, metadata > dc\\:creator')
    ?.textContent?.trim() || '';
  meta.opfDir  = opfDir;
  meta.opfPath = rootfilePath;

  // Manifest
  const manifest = {};
  opfDoc.querySelectorAll('manifest > item').forEach(item => {
    manifest[item.getAttribute('id')] = {
      href:      item.getAttribute('href'),
      mediaType: item.getAttribute('media-type'),
    };
  });

  // Spine (leesvolgorde)
  const spine = [];
  opfDoc.querySelectorAll('spine > itemref').forEach(ref => {
    const id = ref.getAttribute('idref');
    if (manifest[id]) spine.push({ id, ...manifest[id] });
  });

  for (const item of spine) {
    const fullPath = opfDir + item.href;
    const zipFile  = zip.file(fullPath) || zip.file(item.href);
    if (!zipFile) continue;

    const html = await zipFile.async('string');
    const doc  = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style').forEach(el => el.remove());
    const rawText = (doc.body?.innerText || doc.body?.textContent || '').trim();
    if (rawText.length < 50) continue;

    parts.push({
      id: item.id, href: item.href, fullPath,
      html, rawText, modernText: null,
    });
  }

  return { parts, zip, meta };
}

// ── HTML ──────────────────────────────────────────────────────
async function parseHtml(file) {
  const text = await file.text();
  const doc  = new DOMParser().parseFromString(text, 'text/html');
  doc.querySelectorAll('script, style').forEach(el => el.remove());
  return [{
    id: 'chapter-1', href: 'chapter-1.xhtml', fullPath: 'chapter-1.xhtml',
    html:    text,
    rawText: (doc.body?.innerText || doc.body?.textContent || '').trim(),
    modernText: null,
  }];
}

// ── PDF ───────────────────────────────────────────────────────
async function parsePdf(file) {
  const pdf    = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const parts  = [];
  const ppChap = 10;
  let chunk = '', start = 1;

  for (let p = 1; p <= pdf.numPages; p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent();
    chunk += content.items.map(i => i.str).join(' ') + '\n\n';

    if (p % ppChap === 0 || p === pdf.numPages) {
      parts.push({
        id: `ch-${start}`, href: `ch-${start}.xhtml`, fullPath: `ch-${start}.xhtml`,
        html:    `<html><body><p>${chunk.replace(/\n\n/g, '</p><p>').replace(/\n/g, ' ')}</p></body></html>`,
        rawText: chunk.trim(),
        modernText: null,
      });
      chunk = ''; start = p + 1;
    }
  }
  return parts;
}

// ── VTT ───────────────────────────────────────────────────────
async function parseVTT(file) {
  return parseSubtitleCues(await file.text(), 'vtt');
}

// ── SRT ───────────────────────────────────────────────────────
async function parseSRT(file) {
  return parseSubtitleCues(await file.text(), 'srt');
}

// ── SUBTITLE CUE PARSER (gedeeld voor VTT + SRT) ─────────────
function parseSubtitleCues(text, format) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts      = [];

  if (format === 'vtt') {
    const blocks = normalized.split(/\n\n+/);
    let index    = 0;
    for (const block of blocks) {
      const lines    = block.trim().split('\n');
      if (!lines.length) continue;
      if (lines[0].startsWith('WEBVTT') ||
          lines[0].startsWith('STYLE')  ||
          lines[0].startsWith('NOTE'))   continue;

      const timeLine = lines.find(l => l.includes('-->'));
      if (!timeLine) continue;
      const timeIdx  = lines.indexOf(timeLine);
      const id       = timeIdx > 0 ? lines.slice(0, timeIdx).join(' ').trim() : String(++index);
      const match    = timeLine.match(/^([\d:.]+)\s+-->\s+([\d:.]+)(.*)?$/);
      if (!match) continue;

      const textLines = lines.slice(timeIdx + 1).join('\n').trim();
      if (!textLines) continue;

      parts.push({
        id,
        startTime:  match[1],
        endTime:    match[2],
        settings:   (match[3] || '').trim(),
        rawText:    stripSubtitleTags(textLines),
        modernText: null,
        format:     'vtt',
      });
    }
  } else {
    // SRT
    const blocks = normalized.split(/\n\n+/);
    for (const block of blocks) {
      const lines   = block.trim().split('\n');
      if (lines.length < 3) continue;
      let lineIdx   = 0;
      const id      = /^\d+$/.test(lines[0]) ? lines[lineIdx++] : String(parts.length + 1);
      const timeLine = lines[lineIdx++];
      const match   = timeLine?.match(/^([\d:,]+)\s+-->\s+([\d:,]+)/);
      if (!match) continue;

      const textLines = lines.slice(lineIdx).join('\n').trim();
      if (!textLines) continue;

      parts.push({
        id,
        startTime:  srtTimeToVtt(match[1]),
        endTime:    srtTimeToVtt(match[2]),
        settings:   '',
        rawText:    stripSubtitleTags(textLines),
        modernText: null,
        format:     'srt',
      });
    }
  }
  return parts;
}

function srtTimeToVtt(t) { return t.replace(',', '.'); }
function vttTimeToSrt(t) { return t.replace('.', ','); }

function stripSubtitleTags(text) {
  return text.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
}

// ── EPUB HERBOUWEN (originele ZIP + vervangen HTML) ───────────
async function rebuildEpub(zip, parts, meta) {
  const newZip = new JSZip();
  const proms  = [];
  zip.forEach((path, file) => {
    proms.push(file.async('arraybuffer').then(d => newZip.file(path, d)));
  });
  await Promise.all(proms);
  for (const part of parts) {
    if (part.modernText) newZip.file(part.fullPath, part.modernText);
  }
  return newZip.generateAsync({
    type: 'blob', mimeType: 'application/epub+zip',
    compression: 'DEFLATE', compressionOptions: { level: 6 },
  });
}

// ── EPUB BOUWEN VANUIT HTML/PDF ───────────────────────────────
async function buildEpubFromParts(parts, meta, outputLang) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  const manifestItems = parts.map((p, i) =>
    `<item id="ch${i+1}" href="${p.href}" media-type="application/xhtml+xml"/>`
  ).join('\n    ');
  const spineItems = parts.map((p, i) =>
    `<itemref idref="ch${i+1}"/>`
  ).join('\n    ');

  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeHtml(meta.title)}</dc:title>
    <dc:creator>${escapeHtml(meta.author)}</dc:creator>
    <dc:language>${outputLang}</dc:language>
    <dc:identifier id="uid">urn:uuid:${crypto.randomUUID()}</dc:identifier>
  </metadata>
  <manifest>
    ${manifestItems}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">${spineItems}</spine>
</package>`);

  const navPoints = parts.map((p, i) => `
    <navPoint id="nav${i+1}" playOrder="${i+1}">
      <navLabel><text>Part ${i+1}</text></navLabel>
      <content src="${p.href}"/>
    </navPoint>`).join('');

  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:${crypto.randomUUID()}"/></head>
  <docTitle><text>${escapeHtml(meta.title)}</text></docTitle>
  <navMap>${navPoints}</navMap>
</ncx>`);

  for (let i = 0; i < parts.length; i++) {
    zip.file(`OEBPS/${parts[i].href}`, parts[i].modernText || parts[i].html);
  }

  return zip.generateAsync({
    type: 'blob', mimeType: 'application/epub+zip',
    compression: 'DEFLATE', compressionOptions: { level: 6 },
  });
}

// ── VTT OUTPUT ────────────────────────────────────────────────
function buildVTT(parts) {
  let out = 'WEBVTT\n\n';
  for (const part of parts) {
    const text     = (part.modernText || part.rawText).replace(/\n/g, ' ').trim();
    const settings = part.settings ? ' ' + part.settings : '';
    out += `${part.id}\n${part.startTime} --> ${part.endTime}${settings}\n${text}\n\n`;
  }
  return out;
}

// ── SRT OUTPUT ────────────────────────────────────────────────
function buildSRT(parts) {
  let out = '';
  parts.forEach((part, i) => {
    const text  = (part.modernText || part.rawText).replace(/\n/g, ' ').trim();
    const start = vttTimeToSrt(part.startTime);
    const end   = vttTimeToSrt(part.endTime);
    out += `${i + 1}\n${start} --> ${end}\n${text}\n\n`;
  });
  return out;
}

// ── HTML INJECTIE HELPERS ─────────────────────────────────────
function injectModernTextIntoHtml(originalHtml, originalText, modernText) {
  try {
    const doc           = new DOMParser().parseFromString(originalHtml, 'text/html');
    const modernParas   = modernText.split(/\n\n+/).filter(p => p.trim());
    const originalParas = originalText.split(/\n\n+/).filter(p => p.trim());
    const paraMap       = new Map();
    const minLen        = Math.min(originalParas.length, modernParas.length);
    for (let i = 0; i < minLen; i++)
      paraMap.set(normalizeWS(originalParas[i]), modernParas[i]);

    const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const nodes  = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const tn of nodes) {
      const n = normalizeWS(tn.textContent);
      if (paraMap.has(n)) tn.textContent = paraMap.get(n);
    }
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
      new XMLSerializer().serializeToString(doc.documentElement);
  } catch {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="UTF-8"/></head>
<body>${modernText.split(/\n\n+/).map(p => `<p>${escapeHtml(p.trim())}</p>`).join('\n')}</body>
</html>`;
  }
}

function normalizeWS(s) { return s.replace(/\s+/g, ' ').trim(); }
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
