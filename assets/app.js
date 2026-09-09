/* ===== 言語化ノート =====
 * データはブラウザの localStorage にのみ保存される（サーバー送信なし）。
 * entry = { id, date:'YYYY-MM-DD', what, why, conclusion, memo, createdAt, updatedAt }
 */
(() => {
  'use strict';

  const STORE_KEY = 'gengoka-note/entries/v1';
  const DRAFT_KEY = 'gengoka-note/draft/v1';

  const $ = (id) => document.getElementById(id);
  const el = {
    date: $('entryDate'),
    what: $('fWhat'),
    why: $('fWhy'),
    conclusion: $('fConclusion'),
    memo: $('fMemo'),
    form: $('noteForm'),
    saveBtn: $('saveBtn'),
    newBtn: $('newBtn'),
    deleteBtn: $('deleteBtn'),
    list: $('entryList'),
    search: $('search'),
    tabCount: $('tabCount'),
    streak: $('streak'),
    toast: $('toast'),
  };
  const fields = ['what', 'why', 'conclusion', 'memo'];

  let entries = load();
  let editingId = null;

  /* ---------- 保存領域 ---------- */
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error('保存データを読めませんでした', e);
      return [];
    }
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

  /* ---------- 小道具 ---------- */
  const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（ローカル時刻）

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const w = '日月火水木金土'[dt.getDay()];
    return `${y}年${m}月${d}日（${w}）`;
  }

  let toastTimer;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('is-shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-shown'), 2200);
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function readForm() {
    const data = { date: el.date.value || today() };
    fields.forEach((f) => { data[f] = el[f].value.trim(); });
    return data;
  }

  function fillForm(entry) {
    el.date.value = entry.date || today();
    fields.forEach((f) => { el[f].value = entry[f] || ''; });
  }

  /* ---------- 書く ---------- */
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
    if (fields.every((f) => !data[f])) {
      toast('まだ何も書かれていません');
      el.what.focus();
      return;
    }
    const now = new Date().toISOString();
    if (editingId) {
      const entry = entries.find((e) => e.id === editingId);
      Object.assign(entry, data, { updatedAt: now });
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
  function saveDraft() {
    if (editingId) return; // 既存ノートの編集中は下書きを持たない
    const data = readForm();
    if (fields.every((f) => !data[f])) { localStorage.removeItem(DRAFT_KEY); return; }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (e) { /* 上限時は諦める */ }
  }

  function restoreDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return false;
      fillForm(JSON.parse(raw));
      return true;
    } catch (e) { return false; }
  }

  /* ---------- 一覧 ---------- */
  function sorted() {
    return [...entries].sort((a, b) =>
      b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  function render() {
    el.tabCount.textContent = entries.length;
    el.streak.textContent = streakLabel();

    const q = el.search.value.trim().toLowerCase();
    const shown = sorted().filter((e) => !q ||
      [e.date, e.what, e.why, e.conclusion, e.memo].join('\n').toLowerCase().includes(q));

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

      const date = document.createElement('div');
      date.className = 'entry__date';
      date.textContent = formatDate(entry.date);

      const what = document.createElement('p');
      what.className = 'entry__what';
      what.textContent = entry.what || '（メモなし）';

      card.append(date, what);

      if (entry.conclusion) {
        const conclusion = document.createElement('p');
        conclusion.className = 'entry__conclusion';
        conclusion.textContent = entry.conclusion;
        card.append(conclusion);
      }

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

  /* ---------- 書き出し / 読み込み ---------- */
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
      JSON.stringify({ app: 'gengoka-note', version: 1, entries }, null, 2), 'application/json');
  }

  function exportMarkdown() {
    if (!entries.length) return toast('書き出すノートがありません');
    const body = sorted().map((e) => [
      `## ${formatDate(e.date)}`,
      '',
      `### メモ（WHAT）＋のはなぜか？`,
      e.what || '—',
      '',
      '### 理由（WHY）',
      e.why || '—',
      '',
      '### 結論',
      e.conclusion || '—',
      '',
      '### メモ欄',
      e.memo || '—',
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
        if (!raw || typeof raw !== 'object' || !raw.date) return;
        const entry = {
          id: known.has(raw.id) || !raw.id ? uid() : raw.id,
          date: String(raw.date).slice(0, 10),
          createdAt: raw.createdAt || new Date().toISOString(),
          updatedAt: raw.updatedAt || new Date().toISOString(),
        };
        fields.forEach((f) => { entry[f] = typeof raw[f] === 'string' ? raw[f] : ''; });
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

  /* ---------- 画面切り替え ---------- */
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
    document.querySelectorAll('.tab').forEach((t) => {
      const active = t.dataset.view === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
  }

  /* ---------- 起動 ---------- */
  el.form.addEventListener('submit', (ev) => ev.preventDefault());
  el.saveBtn.addEventListener('click', (ev) => { ev.preventDefault(); save(); });
  el.newBtn.addEventListener('click', newEntry);
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
  fields.forEach((f) => el[f].addEventListener('input', saveDraft));
  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); save(); }
  });

  el.date.value = today();
  if (restoreDraft()) toast('書きかけのノートを復元しました');
  render();
})();
