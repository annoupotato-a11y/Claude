/* ===== 言語化ノート =====
 * 書籍『言語化ノート術』の見開きフォーマットを写したノートアプリ。
 * 左ページ = 問い（メモ WHAT ＋のはなぜか？）と理由（WHY）の箇条書き、
 * 右ページ = 結論と行動（見出しは自由にアレンジ可）。
 * データはブラウザの localStorage にのみ保存する（サーバー送信なし）。
 *
 * entry = {
 *   id, date:'YYYY-MM-DD', title, what, conclusion, actionLabel,
 *   why: [line], action: [line], createdAt, updatedAt
 * }
 * line  = { text:'…', marks:[[start,end], …] }   marks = マーカーを引いた範囲
 */
(() => {
  'use strict';

  const STORE_KEY = 'gengoka-note/entries/v2';
  const LEGACY_KEY = 'gengoka-note/entries/v1';
  const DRAFT_KEY = 'gengoka-note/draft/v2';

  const $ = (id) => document.getElementById(id);
  const el = {
    date: $('entryDate'),
    title: $('entryTitle'),
    what: $('fWhat'),
    conclusion: $('fConclusion'),
    actionLabel: $('actionLabel'),
    whyLines: $('whyLines'),
    actionLines: $('actionLines'),
    saveBtn: $('saveBtn'),
    deleteBtn: $('deleteBtn'),
    list: $('entryList'),
    search: $('search'),
    tabCount: $('tabCount'),
    streak: $('streak'),
    toast: $('toast'),
  };
  const PLACEHOLDER = {
    whyLines: '思いついた理由をひとつずつ',
    actionLines: '明日からやること',
  };

  let entries = load();
  let editingId = null;

  /* =========================================================
   * line（テキスト＋マーカー範囲）の操作
   * =======================================================*/
  function normalizeMarks(marks, length) {
    return (Array.isArray(marks) ? marks : [])
      .map(([s, e]) => [Math.max(0, Math.min(s | 0, length)), Math.max(0, Math.min(e | 0, length))])
      .filter(([s, e]) => e > s)
      .sort((a, b) => a[0] - b[0])
      .reduce((acc, range) => {
        const last = acc[acc.length - 1];
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else acc.push(range);
        return acc;
      }, []);
  }

  function makeLine(text = '', marks = []) {
    const value = String(text);
    return { text: value, marks: normalizeMarks(marks, value.length) };
  }

  /** contenteditable の中身を line に変換する（<mark> だけを意味のある要素として読む） */
  function lineFromDom(node) {
    let text = '';
    const marks = [];
    (function walk(parent) {
      parent.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.nodeValue;
        } else if (child.nodeName === 'MARK') {
          const start = text.length;
          text += child.textContent;
          marks.push([start, text.length]);
        } else if (child.nodeName === 'BR') {
          text += ' ';
        } else {
          walk(child);
        }
      });
    })(node);
    return makeLine(text, marks);
  }

  /** line を contenteditable に描き直す */
  function lineToDom(node, line) {
    const { text, marks } = makeLine(line.text, line.marks);
    node.textContent = '';
    let pos = 0;
    marks.forEach(([start, end]) => {
      if (start > pos) node.append(text.slice(pos, start));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(start, end);
      node.append(mark);
      pos = end;
    });
    if (pos < text.length) node.append(text.slice(pos));
  }

  /** 文字列としてのオフセットに変換する（マーカーをまたいでも正しく数える） */
  function offsetOf(root, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  }

  function setCaret(root, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let node;
    const range = document.createRange();
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (seen + len >= offset) {
        range.setStart(node, offset - seen);
        range.collapse(true);
        break;
      }
      seen += len;
      node = null;
    }
    if (!node) {
      range.selectNodeContents(root);
      range.collapse(false);
    }
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus({ preventScroll: true });
  }

  function sliceLine(line, from, to) {
    const marks = line.marks
      .map(([s, e]) => [Math.max(s, from) - from, Math.min(e, to) - from])
      .filter(([s, e]) => e > s);
    return makeLine(line.text.slice(from, to), marks);
  }

  function concatLines(a, b) {
    const shift = a.text.length;
    return makeLine(a.text + b.text, [...a.marks, ...b.marks.map(([s, e]) => [s + shift, e + shift])]);
  }

  /* =========================================================
   * 行（li）の組み立て
   * =======================================================*/
  function createRow(listEl, line) {
    const li = document.createElement('li');
    li.className = 'line';

    const bullet = document.createElement('span');
    bullet.className = 'line__bullet';
    bullet.textContent = '・';

    const text = document.createElement('div');
    text.className = 'line__text';
    text.contentEditable = 'true';
    text.dataset.placeholder = PLACEHOLDER[listEl.id] || '';
    lineToDom(text, makeLine(line && line.text, line && line.marks));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'line__del';
    del.title = 'この行を削除';
    del.textContent = '×';
    del.addEventListener('click', () => {
      const prev = li.previousElementSibling;
      li.remove();
      if (!listEl.children.length) addRow(listEl);
      else if (prev) focusEnd(prev.querySelector('.line__text'));
      saveDraft();
    });

    text.addEventListener('input', saveDraft);
    text.addEventListener('paste', (ev) => {
      ev.preventDefault();
      const plain = (ev.clipboardData || window.clipboardData).getData('text').replace(/\s*\n\s*/g, ' ');
      document.execCommand('insertText', false, plain);
    });
    text.addEventListener('keydown', (ev) => onRowKeydown(ev, listEl, li, text));

    li.append(bullet, text, del);
    return li;
  }

  function addRow(listEl, line, after) {
    const li = createRow(listEl, line);
    if (after) after.after(li);
    else listEl.append(li);
    return li;
  }

  function focusEnd(node) {
    if (!node) return;
    setCaret(node, lineFromDom(node).text.length);
  }

  function onRowKeydown(ev, listEl, li, text) {
    if (ev.isComposing || ev.keyCode === 229) return; // IMEの変換中は横取りしない
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const line = lineFromDom(text);
      const caret = currentOffset(text);
      lineToDom(text, sliceLine(line, 0, caret));
      const next = addRow(listEl, sliceLine(line, caret, line.text.length), li);
      setCaret(next.querySelector('.line__text'), 0);
      saveDraft();
      return;
    }
    if (ev.key === 'Backspace' && currentOffset(text) === 0 && window.getSelection().isCollapsed) {
      const prev = li.previousElementSibling;
      if (!prev) return;
      ev.preventDefault();
      const prevText = prev.querySelector('.line__text');
      const head = lineFromDom(prevText);
      lineToDom(prevText, concatLines(head, lineFromDom(text)));
      li.remove();
      setCaret(prevText, head.text.length);
      saveDraft();
    }
  }

  function currentOffset(root) {
    const selection = window.getSelection();
    if (!selection.rangeCount || !root.contains(selection.anchorNode)) return 0;
    const range = selection.getRangeAt(0);
    return offsetOf(root, range.startContainer, range.startOffset);
  }

  /* =========================================================
   * マーカー
   * =======================================================*/
  function toggleMark() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return toast('マーカーを引く言葉を選んでください');
    const range = selection.getRangeAt(0);
    const anchor = range.startContainer;
    const base = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
    const root = base && base.closest('.line__text');
    if (!root || !root.contains(range.endContainer)) return toast('理由・行動の文字を選んでからマーカーを押してください');
    if (range.collapsed) return toast('マーカーを引く言葉を選んでください');

    const from = offsetOf(root, range.startContainer, range.startOffset);
    const to = offsetOf(root, range.endContainer, range.endOffset);
    const line = lineFromDom(root);
    const covered = line.marks.some(([s, e]) => s <= from && e >= to);
    const marks = covered
      ? line.marks.flatMap(([s, e]) => [[s, Math.min(e, from)], [Math.max(s, to), e]])
      : [...line.marks, [from, to]];

    lineToDom(root, makeLine(line.text, marks));
    setCaret(root, to);
    saveDraft();
  }

  /* =========================================================
   * 保存領域
   * =======================================================*/
  function toLine(raw) {
    if (typeof raw === 'string') return makeLine(raw);
    return makeLine(raw && raw.text, raw && raw.marks);
  }

  function toLines(raw) {
    if (Array.isArray(raw)) return raw.map(toLine).filter((l) => l.text.trim());
    return String(raw || '')
      .split('\n')
      .map((t) => t.replace(/^[\s・\-*•]+/, '').trim())
      .filter(Boolean)
      .map((t) => makeLine(t));
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || !raw.date) return null;
    const now = new Date().toISOString();
    return {
      id: raw.id || uid(),
      date: String(raw.date).slice(0, 10),
      title: String(raw.title || ''),
      what: String(raw.what || ''),
      why: toLines(raw.why),
      conclusion: String(raw.conclusion || ''),
      actionLabel: String(raw.actionLabel || '行動'),
      action: toLines(raw.action !== undefined ? raw.action : raw.memo), // v1 の「メモ欄」を引き継ぐ
      createdAt: raw.createdAt || now,
      updatedAt: raw.updatedAt || now,
    };
  }

  function load() {
    const read = (key) => {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || 'null');
        const list = Array.isArray(parsed) ? parsed : parsed && parsed.entries;
        return Array.isArray(list) ? list : [];
      } catch (e) {
        console.error('保存データを読めませんでした', e);
        return [];
      }
    };
    const stored = read(STORE_KEY);
    if (stored.length) return stored.map(normalizeEntry).filter(Boolean);
    const legacy = read(LEGACY_KEY).map(normalizeEntry).filter(Boolean); // 旧フォーマットからの引っ越し
    if (legacy.length) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(legacy)); } catch (e) { /* 失敗しても表示はできる */ }
    }
    return legacy;
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(entries));
      return true;
    } catch (e) {
      toast('保存できませんでした（保存領域の上限かもしれません）');
      return false;
    }
  }

  /* =========================================================
   * 小道具
   * =======================================================*/
  const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（ローカル時刻）
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const week = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
    return `${y}年${m}月${d}日（${week}）`;
  }

  let toastTimer;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('is-shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-shown'), 2400);
  }

  function autoGrow(node) {
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }

  /* =========================================================
   * フォーム
   * =======================================================*/
  function readList(listEl) {
    return [...listEl.querySelectorAll('.line__text')]
      .map(lineFromDom)
      .filter((line) => line.text.trim());
  }

  function fillList(listEl, lines) {
    listEl.textContent = '';
    (lines && lines.length ? lines : [makeLine()]).forEach((line) => addRow(listEl, line));
  }

  function readForm() {
    return {
      date: el.date.value || today(),
      title: el.title.value.trim(),
      what: el.what.value.trim(),
      why: readList(el.whyLines),
      conclusion: el.conclusion.value.trim(),
      actionLabel: el.actionLabel.value.trim() || '行動',
      action: readList(el.actionLines),
    };
  }

  function fillForm(entry) {
    el.date.value = entry.date || today();
    el.title.value = entry.title || '';
    el.what.value = entry.what || '';
    el.conclusion.value = entry.conclusion || '';
    el.actionLabel.value = entry.actionLabel || '行動';
    fillList(el.whyLines, entry.why);
    fillList(el.actionLines, entry.action);
    [el.what, el.conclusion].forEach(autoGrow);
  }

  const isBlank = (data) =>
    !data.what && !data.conclusion && !data.title && !data.why.length && !data.action.length;

  function newEntry() {
    editingId = null;
    fillForm({ date: today() });
    el.deleteBtn.hidden = true;
    el.saveBtn.textContent = '保存する';
    localStorage.removeItem(DRAFT_KEY);
    el.what.focus();
  }

  function save() {
    const data = readForm();
    if (isBlank(data)) {
      toast('まだ何も書かれていません');
      el.what.focus();
      return;
    }
    const now = new Date().toISOString();
    if (editingId) {
      Object.assign(entries.find((e) => e.id === editingId), data, { updatedAt: now });
    } else {
      const entry = Object.assign({ id: uid(), createdAt: now, updatedAt: now }, data);
      entries.push(entry);
      editingId = entry.id;
    }
    if (!persist()) return;
    localStorage.removeItem(DRAFT_KEY);
    el.deleteBtn.hidden = false;
    el.saveBtn.textContent = '更新する';
    render();
    toast('保存しました');
  }

  function edit(id) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    editingId = id;
    fillForm(entry);
    el.deleteBtn.hidden = false;
    el.saveBtn.textContent = '更新する';
    showView('write');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function remove() {
    if (!editingId) return;
    if (!confirm('このノートを削除しますか？')) return;
    entries = entries.filter((e) => e.id !== editingId);
    persist();
    newEntry();
    render();
    toast('削除しました');
  }

  /* ---------- 下書きの自動保存 ---------- */
  let draftTimer;
  function saveDraft() {
    if (editingId) return; // 既存ノートの編集中は下書きを持たない
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      const data = readForm();
      if (isBlank(data)) { localStorage.removeItem(DRAFT_KEY); return; }
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (e) { /* 上限時は諦める */ }
    }, 300);
  }

  function restoreDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!draft) return false;
      fillForm(normalizeEntry(Object.assign({ date: today() }, draft)));
      return true;
    } catch (e) { return false; }
  }

  /* =========================================================
   * 一覧
   * =======================================================*/
  const plain = (entry) => [
    entry.date, entry.title, entry.what, entry.conclusion, entry.actionLabel,
    ...entry.why.map((l) => l.text), ...entry.action.map((l) => l.text),
  ].join('\n');

  function sorted() {
    return [...entries].sort((a, b) =>
      b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  function render() {
    el.tabCount.textContent = entries.length;
    el.streak.textContent = streakLabel();

    const query = el.search.value.trim().toLowerCase();
    const shown = sorted().filter((e) => !query || plain(e).toLowerCase().includes(query));

    el.list.textContent = '';
    if (!shown.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = entries.length
        ? '該当するノートはありません'
        : 'まだノートがありません。「書く」から今日の一件を残しましょう。';
      el.list.append(p);
      return;
    }

    shown.forEach((entry) => {
      const card = document.createElement('article');
      card.className = 'entry';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');

      const head = document.createElement('div');
      head.className = 'entry__date';
      head.textContent = formatDate(entry.date);
      if (entry.title) {
        const title = document.createElement('span');
        title.className = 'entry__title';
        title.textContent = entry.title;
        head.append(title);
      }

      const what = document.createElement('p');
      what.className = 'entry__what';
      what.textContent = `${entry.what || '（メモなし）'}のはなぜか？`;

      card.append(head, what);

      if (entry.conclusion) {
        const conclusion = document.createElement('p');
        conclusion.className = 'entry__conclusion';
        conclusion.textContent = entry.conclusion;
        card.append(conclusion);
      }

      const meta = document.createElement('p');
      meta.className = 'entry__meta';
      meta.textContent = `理由 ${entry.why.length}件 ／ ${entry.actionLabel} ${entry.action.length}件`;
      card.append(meta);

      const open = () => edit(entry.id);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
      el.list.append(card);
    });
  }

  function streakLabel() {
    if (!entries.length) return '';
    const days = new Set(entries.map((e) => e.date));
    const cursor = new Date();
    // 今日まだ書いていなければ、昨日からの連続を数える
    if (!days.has(cursor.toLocaleDateString('sv-SE'))) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    while (days.has(cursor.toLocaleDateString('sv-SE'))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak > 1 ? `${streak}日連続で記録中` : `これまで${days.size}日分`;
  }

  /* =========================================================
   * 書き出し / 読み込み
   * =======================================================*/
  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    if (!entries.length) return toast('書き出すノートがありません');
    download(`言語化ノート_${today()}.json`,
      JSON.stringify({ app: 'gengoka-note', version: 2, entries }, null, 2), 'application/json');
  }

  /** マーカー部分は Markdown の ==強調== として書き出す */
  const lineToMd = (line) => {
    let out = '';
    let pos = 0;
    line.marks.forEach(([s, e]) => {
      out += `${line.text.slice(pos, s)}==${line.text.slice(s, e)}==`;
      pos = e;
    });
    return `- ${out + line.text.slice(pos)}`;
  };

  function exportMarkdown() {
    if (!entries.length) return toast('書き出すノートがありません');
    const body = sorted().map((e) => [
      `## ${formatDate(e.date)}${e.title ? ` ${e.title}` : ''}`,
      '',
      `### 問い`,
      `${e.what || '—'}のはなぜか？`,
      '',
      '### 理由（WHY）',
      e.why.length ? e.why.map(lineToMd).join('\n') : '—',
      '',
      '### 結論',
      e.conclusion || '—',
      '',
      `### ${e.actionLabel}`,
      e.action.length ? e.action.map(lineToMd).join('\n') : '—',
    ].join('\n')).join('\n\n---\n\n');
    download(`言語化ノート_${today()}.md`, `# 言語化ノート\n\n${body}\n`, 'text/markdown');
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let incoming;
      try {
        const parsed = JSON.parse(reader.result);
        incoming = Array.isArray(parsed) ? parsed : parsed.entries;
      } catch (e) { /* 下で弾く */ }
      if (!Array.isArray(incoming)) return toast('読み込めるノートが見つかりませんでした');

      const known = new Set(entries.map((e) => e.id));
      let added = 0;
      incoming.forEach((raw) => {
        const entry = normalizeEntry(raw);
        if (!entry) return;
        if (known.has(entry.id)) entry.id = uid();
        known.add(entry.id);
        entries.push(entry);
        added++;
      });
      persist();
      render();
      toast(added ? `${added}件のノートを読み込みました` : '追加できるノートはありませんでした');
    };
    reader.readAsText(file);
  }

  /* =========================================================
   * 画面切り替え・起動
   * =======================================================*/
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
    document.querySelectorAll('.tab').forEach((t) => {
      const active = t.dataset.view === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
  }

  el.saveBtn.addEventListener('click', save);
  $('newBtn').addEventListener('click', newEntry);
  $('printBtn').addEventListener('click', () => window.print());
  el.deleteBtn.addEventListener('click', remove);
  el.search.addEventListener('input', render);
  $('exportBtn').addEventListener('click', exportJson);
  $('exportMdBtn').addEventListener('click', exportMarkdown);
  $('importInput').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (file) importJson(file);
    ev.target.value = '';
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

  document.querySelectorAll('.add-line').forEach((btn) => btn.addEventListener('click', () => {
    const listEl = $(btn.dataset.add);
    focusEnd(addRow(listEl).querySelector('.line__text'));
  }));
  document.querySelectorAll('.mark-btn').forEach((btn) => {
    btn.addEventListener('mousedown', (ev) => ev.preventDefault()); // 選択範囲を保ったまま押せるように
    btn.addEventListener('click', toggleMark);
  });

  [el.what, el.conclusion].forEach((node) => node.addEventListener('input', () => { autoGrow(node); saveDraft(); }));
  [el.title, el.actionLabel, el.date].forEach((node) => node.addEventListener('input', saveDraft));

  document.addEventListener('keydown', (ev) => {
    if (!(ev.metaKey || ev.ctrlKey)) return;
    const key = ev.key.toLowerCase();
    if (key === 's' || (key === 'enter' && !ev.isComposing)) { ev.preventDefault(); save(); }
    if (key === 'm') { ev.preventDefault(); toggleMark(); }
  });

  el.date.value = today();
  [el.what, el.conclusion].forEach(autoGrow);
  fillList(el.whyLines);
  fillList(el.actionLines);
  if (restoreDraft()) toast('書きかけのノートを復元しました');
  render();
})();
