// markdown.js — a compact, dependency-free Markdown→HTML renderer, enough for our
// PORTIERUNG.md (headings, bold, inline code, code fences, lists, tables, links,
// blockquotes, horizontal rules, paragraphs).

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// inline: `code`, **bold**, [text](url)
function inline(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i) { out += '<code>' + esc(s.slice(i + 1, j)) + '</code>'; i = j + 1; continue; }
    }
    if (ch === '*' && s[i + 1] === '*') {
      const j = s.indexOf('**', i + 2);
      if (j > i) { out += '<strong>' + inline(s.slice(i + 2, j)) + '</strong>'; i = j + 2; continue; }
    }
    if (ch === '[') {
      const close = s.indexOf(']', i);
      if (close > i && s[close + 1] === '(') {
        const end = s.indexOf(')', close + 2);
        if (end > close) {
          const text = s.slice(i + 1, close);
          const href = s.slice(close + 2, end);
          const safe = /^https?:\/\//.test(href) ? href : '#';
          out += `<a href="${esc(safe)}"${safe !== '#' ? ' target="_blank" rel="noopener"' : ''}>` +
                 inline(text) + '</a>';
          i = end + 1; continue;
        }
      }
    }
    out += esc(ch);
    i++;
  }
  return out;
}

function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;
  let listType = null; // 'ul' | 'ol'
  const closeList = () => { if (listType) { html.push(`</${listType}>`); listType = null; } };

  while (i < lines.length) {
    let line = lines[i];

    // code fence
    if (/^```/.test(line)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
      i++; // skip closing fence
      html.push('<pre><code>' + buf.join('\n') + '</code></pre>');
      continue;
    }
    // table: a line with | and the next line is a separator |---|
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      closeList();
      const parseRow = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const header = parseRow(line);
      i += 2;
      html.push('<table><thead><tr>' + header.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = parseRow(lines[i]);
        html.push('<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
        i++;
      }
      html.push('</tbody></table>');
      continue;
    }
    // heading
    let m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) { closeList(); const n = m[1].length; html.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    // hr
    if (/^\s*(---|___|\*\*\*)\s*$/.test(line)) { closeList(); html.push('<hr>'); i++; continue; }
    // blockquote
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^\s*>\s?/, ''))); i++; }
      html.push('<blockquote>' + buf.join('<br>') + '</blockquote>');
      continue;
    }
    // list item (unordered or ordered) — gather wrapped continuation lines
    const um = /^\s*[-*]\s+(.*)$/.exec(line);
    const om = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (um || om) {
      const want = um ? 'ul' : 'ol';
      if (listType !== want) { closeList(); html.push(`<${want}>`); listType = want; }
      const parts = [(um || om)[1]];
      i++;
      while (i < lines.length && lines[i].trim() !== '' &&
             !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) &&
             !/^(#{1,6}\s|```|\s*>|\s*(---|___|\*\*\*)\s*$)/.test(lines[i])) {
        parts.push(lines[i].trim()); i++;
      }
      html.push('<li>' + inline(parts.join(' ')) + '</li>');
      continue;
    }
    // blank line
    if (line.trim() === '') { closeList(); i++; continue; }
    // paragraph: gather raw lines, join, THEN inline once (so **bold** may span lines)
    closeList();
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*>|\s*(---|___|\*\*\*)\s*$)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && lines[i+1].includes('|'))) {
      buf.push(lines[i]); i++;
    }
    html.push('<p>' + inline(buf.join(' ')) + '</p>');
  }
  closeList();
  return html.join('\n');
}

export { mdToHtml };
