/* カロリー手帳 : 写真から食事のカロリーを推定して1日ごとに記録する
 *
 * 解析は2通り。claude.ai の Artifact として開いたときは閲覧者の Claude（sample 機能）を使い、
 * それ以外では設定に入れた Anthropic API キーでブラウザから直接 Messages API を呼ぶ。
 * どちらも使えないときは手入力だけで記録できる。
 */
(() => {
  'use strict';

  const MEALS_KEY = 'calorie-note/meals/v1';
  const SETTINGS_KEY = 'calorie-note/settings/v1';
  const API_KEY_KEY = 'calorie-note/api-key';   // 端末の外には出さない
  const MODEL = 'claude-opus-5-5';
  const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const TYPES = { breakfast: '朝食', lunch: '昼食', dinner: '夕食', snack: '間食' };
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  // PFC の目安（エネルギー比）: たんぱく質15% / 脂質25% / 炭水化物60%
  const PFC_RATIO = { p: [0.15, 4], f: [0.25, 9], c: [0.60, 4] };

  const $ = (id) => document.getElementById(id);
  const el = {
    tabs: document.querySelectorAll('.tab'),
    views: document.querySelectorAll('.view'),
    dayLabel: $('dayLabel'), dayInput: $('dayInput'), prevDay: $('prevDay'), nextDay: $('nextDay'),
    todayBtn: $('todayBtn'), sync: $('sync'),
    ring: $('ring'), ringValue: $('ringValue'), eatenKcal: $('eatenKcal'), goalKcal: $('goalKcal'),
    remain: $('remain'), meters: $('meters'),
    cameraInput: $('cameraInput'), libraryInput: $('libraryInput'), manualBtn: $('manualBtn'),
    engineNote: $('engineNote'),
    productForm: $('productForm'), productInput: $('productInput'), productList: $('productList'), productBtn: $('productBtn'),
    editor: $('editor'), editorPhoto: $('editorPhoto'), mealType: $('mealType'), mealTime: $('mealTime'),
    preNote: $('preNote'), hintLabel: $('hintLabel'), hintInput: $('hintInput'), reanalyzeBtn: $('reanalyzeBtn'),
    questions: $('questions'), notesList: $('notesList'),
    status: $('status'), statusText: $('statusText'), stopBtn: $('stopBtn'), aiNote: $('aiNote'),
    items: $('items'), addItem: $('addItem'), labelTotal: $('labelTotal'),
    cancelBtn: $('cancelBtn'), deleteBtn: $('deleteBtn'), saveBtn: $('saveBtn'),
    meals: $('meals'),
    weekAvg: $('weekAvg'), weekChart: $('weekChart'), weekTable: $('weekTable'),
    exportRange: $('exportRange'), excelBtn: $('excelBtn'),
    goalForm: $('goalForm'), goalInput: $('goalInput'),
    pSex: $('pSex'), pAge: $('pAge'), pHeight: $('pHeight'), pWeight: $('pWeight'),
    pActivity: $('pActivity'), pPlan: $('pPlan'), calcOut: $('calcOut'), applyCalc: $('applyCalc'),
    keyForm: $('keyForm'), apiKey: $('apiKey'), clearKey: $('clearKey'), engineState: $('engineState'),
    dataState: $('dataState'), exportBtn: $('exportBtn'), importInput: $('importInput'),
    toast: $('toast'),
  };

  /* ---------- 小物 ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const today = () => ymd(new Date());
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const round = (n) => Math.round(n);
  const round1 = (n) => Math.round(n * 10) / 10;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const fmt = (n) => round(n).toLocaleString('ja-JP');
  const dayText = (s) => { const d = parseYmd(s); return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`; };

  function readJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function readText(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function writeText(key, value) {
    try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch (e) { /* 保存できなくても続ける */ }
  }

  let toastTimer = 0;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-show'), 2600);
  }

  const guessType = (date) => {
    const h = date.getHours();
    if (h >= 4 && h < 10) return 'breakfast';
    if (h >= 10 && h < 15) return 'lunch';
    if (h >= 17 && h < 22) return 'dinner';
    return 'snack';
  };

  /* ---------- データ ---------- */
  function normalizeItem(it) {
    if (!it || typeof it !== 'object') return null;
    return {
      name: String(it.name || '').slice(0, 60),
      amount: String(it.amount || '').slice(0, 30),
      kcal: round(num(it.kcal)),
      p: round1(num(it.p ?? it.protein)),
      f: round1(num(it.f ?? it.fat)),
      c: round1(num(it.c ?? it.carbs)),
    };
  }
  function normalizeMeal(m) {
    if (!m || typeof m !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(m.date || '')) return null;
    return {
      id: String(m.id || uid()),
      date: m.date,
      time: /^\d{2}:\d{2}$/.test(m.time || '') ? m.time : '12:00',
      type: TYPES[m.type] ? m.type : 'snack',
      items: (Array.isArray(m.items) ? m.items : []).map(normalizeItem).filter(Boolean),
      photo: typeof m.photo === 'string' && m.photo.startsWith('data:image/') ? m.photo : '',
      product: typeof m.product === 'string' ? m.product.slice(0, 80) : '',   // 商品名で記録したとき
      notes: (Array.isArray(m.notes) ? m.notes : []).map((n) => String(n).trim().slice(0, 200)).filter(Boolean).slice(0, 10),
      createdAt: m.createdAt || new Date().toISOString(),
      updatedAt: m.updatedAt || m.createdAt || new Date().toISOString(),
    };
  }
  const totals = (items) => items.reduce((t, it) => ({
    kcal: t.kcal + it.kcal, p: t.p + it.p, f: t.f + it.f, c: t.c + it.c,
  }), { kcal: 0, p: 0, f: 0, c: 0 });

  let meals = readJSON(MEALS_KEY, []).map(normalizeMeal).filter(Boolean);
  let settings = Object.assign({ goal: 2000, profile: {} }, readJSON(SETTINGS_KEY, {}));
  let currentDay = today();

  function persist() {
    if (!writeJSON(MEALS_KEY, meals)) toast('この端末の保存領域がいっぱいです。古い写真付きの記録を消すか、バックアップしてください');
  }
  const mealsOn = (date) => meals.filter((m) => m.date === date).sort((a, b) => a.time.localeCompare(b.time));

  /* ---------- クラウド保存（claude.ai で開いたときだけ）---------- */
  const cloud = { db: null, path: '' };

  function setSync(text) { el.sync.textContent = text; el.sync.hidden = !text; }

  async function connectCloud() {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    const [db, user] = await Promise.all([
      window.claude.use('db').catch(() => null),
      window.claude.use('user').catch(() => null),
    ]);
    if (!db || !user) return;
    const id = await user.id().catch(() => null);
    if (!id) return;
    // data/users/<id>/ は本人しか読めない場所。食事の記録はここに置く
    cloud.path = `data/users/${id}`;
    cloud.db = db;
    try {
      const snap = await db.collection(cloud.path).get();
      const remote = [];
      snap.docs.forEach((doc) => {
        if (doc.id === 'settings') {
          const s = doc.data();
          if (s && s.goal) settings = Object.assign(settings, { goal: s.goal, profile: s.profile || {} });
          return;
        }
        const m = normalizeMeal(Object.assign({ id: doc.id }, doc.data()));
        if (m) remote.push(m);
      });
      const remoteIds = new Set(remote.map((m) => m.id));
      const onlyHere = meals.filter((m) => !remoteIds.has(m.id));
      meals = remote.concat(onlyHere);
      persist();
      writeJSON(SETTINGS_KEY, settings);
      renderAll();
      for (const m of onlyHere) await pushMeal(m);
      if (onlyHere.length) toast(`${onlyHere.length}件の記録をクラウドへ移しました`);
      db.collection(cloud.path).onSnapshot((s) => {
        const next = [];
        s.docs.forEach((doc) => {
          if (doc.id === 'settings') return;
          const m = normalizeMeal(Object.assign({ id: doc.id }, doc.data()));
          if (m) next.push(m);
        });
        meals = next;
        persist();
        renderDay();
        renderWeek();
      }, () => setSync('この端末に保存'));
      setSync('☁ 同期中');
    } catch (e) {
      cloud.db = null;
      setSync('この端末に保存');
    }
  }
  function pushMeal(m) {
    if (!cloud.db) return Promise.resolve();
    const { id, ...rest } = m;
    return cloud.db.doc(`${cloud.path}/${id}`).set(rest)
      .catch(() => toast('クラウドに保存できませんでした（この端末には保存済み）'));
  }
  function dropMeal(id) {
    if (!cloud.db) return Promise.resolve();
    return cloud.db.doc(`${cloud.path}/${id}`).delete().catch(() => {});
  }
  function pushSettings() {
    if (!cloud.db) return;
    cloud.db.doc(`${cloud.path}/settings`).set({ goal: settings.goal, profile: settings.profile }).catch(() => {});
  }

  /* ---------- 画像 ---------- */
  async function loadImage(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* 下で読む */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function drawScaled(img, maxSide, square) {
    const w = img.width, h = img.height;
    const canvas = document.createElement('canvas');
    if (square) {
      const s = Math.min(w, h);
      canvas.width = canvas.height = Math.min(maxSide, s);
      canvas.getContext('2d').drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, canvas.width, canvas.height);
    } else {
      const k = Math.min(1, maxSide / Math.max(w, h));
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    return canvas;
  }
  const toBlob = (canvas, q) => new Promise((ok, ng) => canvas.toBlob((b) => (b ? ok(b) : ng(new Error('画像を変換できませんでした'))), 'image/jpeg', q));
  const blobToBase64 = (blob) => new Promise((ok, ng) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => ng(r.error);
    r.readAsDataURL(blob);
  });

  /* ---------- 解析エンジン ---------- */
  const engine = { sample: null, imagesOk: false };

  async function detectSample() {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    const sample = await window.claude.use('sample').catch(() => null);
    if (!sample) return;
    const limits = await sample.limits().catch(() => null);
    engine.sample = sample;
    engine.imagesOk = !!(limits && limits.images);
    renderEngine();
  }
  // 写真の解析には画像を送れる Claude が要る。商品名だけなら文字だけで足りる
  const engineKind = (image = true) => (engine.sample && (!image || engine.imagesOk) ? 'claude' : readText(API_KEY_KEY) ? 'apikey' : 'none');

  function renderEngine() {
    const kind = engineKind();
    el.engineState.textContent = kind === 'claude'
      ? 'claude.ai のアカウントで解析します（キーは不要です）'
      : kind === 'apikey' ? 'API キーで解析します' : '解析の準備ができていません。API キーを入れるか、claude.ai で開いてください';
    el.engineNote.hidden = kind !== 'none';
    if (kind === 'none') {
      el.engineNote.innerHTML = '';
      el.engineNote.append('写真の解析には「設定」で API キーが必要です。写真なしの手入力はいつでも使えます。 ');
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'text-btn';
      go.textContent = '設定を開く';
      go.addEventListener('click', () => showView('settings'));
      el.engineNote.append(go);
    }
  }

  // 写真があれば写真＋補足から、なければ補足の文章だけから推定する。
  // previous（前回の推定）を渡すと、補足に合わせて必要なところだけ直してもらう
  const PROMPT = ({ hasPhoto, notes, previous }) => [
    hasPhoto ? 'この写真の食事の栄養を推定してください。' : '次の文章で説明された食事の栄養を推定してください。',
    hasPhoto
      ? '写っている料理・食品を1品ずつ挙げ、日本の一般的な1人前や、器・箸・手などの大きさから量を見積もり、'
      : '説明に出てくる料理・食品を1品ずつ挙げ、量の記載がなければ日本の一般的な1人前として、',
    'それぞれのエネルギー(kcal)・たんぱく質(g)・脂質(g)・炭水化物(g)を日本食品標準成分表の値を目安に推定します。',
    '揚げ物の衣や油、ソース・ドレッシング、飲み物も含めてください。',
    notes.length
      ? ['', `${hasPhoto ? '食べた人からの補足（写真より優先します。' : '食べた人の説明と補足（'}量の違い・食べ残し・おかわり・見えない中身・調味料や油の量・調理法などを反映してください）:`,
        ...notes.map((n) => `- ${n}`)].join('\n')
      : '',
    previous && previous.length
      ? ['', '前回の推定（補足に関係するところだけ直し、ほかはそのままにしてください）:',
        JSON.stringify(previous.map((it) => ({ name: it.name, amount: it.amount, kcal: it.kcal, protein: it.p, fat: it.f, carbs: it.c })))].join('\n')
      : '',
    '',
    hasPhoto ? '食べ物が写っていない場合は dishes を空にし、note にその旨を書いてください。' : '食べ物が分からない場合は dishes を空にし、note にその旨を書いてください。',
    `${hasPhoto ? '写真だけでは' : '説明だけでは'}判断できず、答えによって推定が大きく変わる点があれば、questions に食べた人への短い質問を最大3つ、影響の大きい順に入れます。`,
    'それぞれ options に、タップで答えられる短い選択肢を2〜4個付けます（例：質問「ご飯の量は？」→ 選択肢「少なめ」「普通盛り」「大盛り」「半分残した」）。',
    '補足ですでに分かっていることは聞かず、なければ空にします。',
    '',
    '次の形の JSON だけを返してください。name・amount・note・questions は日本語で書きます。',
    '{"dishes":[{"name":"鶏の唐揚げ","amount":"5個（約150g）","kcal":420,"protein":28,"fat":26,"carbs":15}],',
    ' "confidence":"high|medium|low", "note":"推定の前提や補足をどう反映したかを1文で", "questions":[{"question":"ご飯の量は？","options":["少なめ","普通盛り","大盛り"]}]}',
  ].filter(Boolean).join('\n');

  const RESULT_SCHEMA = {
    type: 'object',
    properties: {
      dishes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' }, amount: { type: 'string' },
            kcal: { type: 'number' }, protein: { type: 'number' }, fat: { type: 'number' }, carbs: { type: 'number' },
          },
          required: ['name', 'amount', 'kcal', 'protein', 'fat', 'carbs'],
          additionalProperties: false,
        },
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      note: { type: 'string' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
          required: ['question', 'options'],
          additionalProperties: false,
        },
      },
    },
    required: ['dishes', 'confidence', 'note', 'questions'],
    additionalProperties: false,
  };

  const PRODUCT_PROMPT = (name) => [
    `日本で売られている市販の商品「${name}」を食べました。この商品の栄養成分を答えてください。`,
    '入力に個数や量（「2個」「半分」など）が含まれていればその量に換算し、なければ1個（1食分・1袋）とします。',
    'パッケージの栄養成分表示の値を知っている場合はその値を使い、confidence を "high" にします。',
    '知らない場合は同じ種類の一般的な商品から推定し、confidence を "medium" か "low" にして、note に推定であることを書きます。',
    '食べ物や飲み物の商品として解釈できない場合は dishes を空にし、note に理由を書きます。',
    '',
    'dishes には商品を1件だけ入れます。name は商品名、amount は「1個（約110g）」のように書きます。',
    '次の形の JSON だけを返してください。',
    '{"dishes":[{"name":"ツナマヨネーズおにぎり","amount":"1個（約110g）","kcal":230,"protein":5,"fat":7,"carbs":37}],',
    ' "confidence":"high|medium|low", "note":"値の出どころを1文で"}',
  ].join('\n');

  class AnalyzeError extends Error {
    constructor(message, quiet) { super(message); this.quiet = !!quiet; }
  }

  async function analyzeWithClaude(prompt, blob, signal) {
    try {
      return await engine.sample.json(prompt, blob ? { images: [blob], signal, cache: false } : { signal, cache: false });
    } catch (e) {
      const code = e && e.code;
      if (code === 'cancelled') throw new AnalyzeError('', true);
      if (code === 'not_granted' || code === 'sampling_disabled' || code === 'images_unavailable') {
        if (code === 'images_unavailable') engine.imagesOk = false; else engine.sample = null;
        renderEngine();
        throw new AnalyzeError('この画面では Claude を使えません。手入力するか、設定で API キーを入れてください');
      }
      if (code === 'rate_limited') throw new AnalyzeError('Claude の利用上限に達しました。しばらくしてから「もう一度解析」を押してください');
      if (code === 'image_rejected') throw new AnalyzeError('この画像は読み取れませんでした。別の写真で試してください');
      if (code === 'refused') throw new AnalyzeError('この写真は解析できませんでした。手で入力してください');
      if (code === 'session_expired') throw new AnalyzeError('claude.ai に再ログインしてから試してください');
      throw new AnalyzeError('解析に失敗しました。「もう一度解析」を押してください');
    }
  }

  async function analyzeWithApiKey(prompt, blob, signal) {
    const content = [{ type: 'text', text: prompt }];
    if (blob) content.unshift({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64(blob) } });
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': readText(API_KEY_KEY),
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'server-side-fallback-2026-07-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 16000,
          fallbacks: 'default',
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: RESULT_SCHEMA } },
          messages: [{ role: 'user', content }],
        }),
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new AnalyzeError('', true);
      throw new AnalyzeError('通信できませんでした。電波の状態を確かめてください');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401) throw new AnalyzeError('API キーが正しくありません。設定で入れ直してください');
      if (res.status === 429) throw new AnalyzeError('API の利用上限に達しました。少し待ってから試してください');
      if (res.status === 413) throw new AnalyzeError('画像が大きすぎます。別の写真で試してください');
      const msg = body && body.error && body.error.message;
      throw new AnalyzeError(`解析に失敗しました（${res.status}${msg ? `: ${msg}` : ''}）`);
    }
    if (body.stop_reason === 'refusal') throw new AnalyzeError('この写真は解析できませんでした。手で入力してください');
    const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    try { return JSON.parse(text); } catch (e) { throw new AnalyzeError('解析結果を読み取れませんでした。「もう一度解析」を押してください'); }
  }

  /* ---------- 編集欄 ---------- */
  let draft = null;          // 編集中の食事
  let draftBlob = null;      // 解析に送る画像（再解析用）
  let analyzing = null;      // AbortController

  function openEditor(meal, isNew) {
    draft = JSON.parse(JSON.stringify(meal));
    draft.isNew = isNew;
    el.editor.hidden = false;
    el.editorPhoto.hidden = !draft.photo;
    if (draft.photo) el.editorPhoto.src = draft.photo;
    el.mealTime.value = draft.time;
    el.hintInput.value = '';
    el.aiNote.hidden = true;
    renderQuestions([]);
    renderNotes();
    el.deleteBtn.hidden = isNew;
    el.deleteBtn.textContent = '削除';
    delete el.deleteBtn.dataset.armed;
    el.saveBtn.textContent = isNew ? '記録する' : '更新する';
    renderType();
    renderItems();
    el.editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeEditor() {
    if (analyzing) analyzing.abort();
    draft = null;
    draftBlob = null;
    el.editor.hidden = true;
  }
  function renderType() {
    el.mealType.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.type === draft.type)));
  }

  function itemRow(it, i) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `
      <div class="item__name">
        <input type="text" data-k="name" placeholder="料理名" aria-label="料理名">
        <input type="text" data-k="amount" placeholder="量" aria-label="量">
      </div>
      <label class="item__kcal"><input type="number" data-k="kcal" min="0" inputmode="numeric" aria-label="エネルギー"><small>kcal</small></label>
      <button type="button" class="item__del" aria-label="この品目を消す">×</button>
      <div class="item__pfc">
        <label>P<input type="number" data-k="p" min="0" step="0.1" inputmode="decimal" aria-label="たんぱく質"><small>g</small></label>
        <label>F<input type="number" data-k="f" min="0" step="0.1" inputmode="decimal" aria-label="脂質"><small>g</small></label>
        <label>C<input type="number" data-k="c" min="0" step="0.1" inputmode="decimal" aria-label="炭水化物"><small>g</small></label>
      </div>`;
    row.querySelectorAll('input').forEach((input) => {
      const k = input.dataset.k;
      input.id = `item-${i}-${k}`;
      input.value = k === 'name' || k === 'amount' ? it[k] : (it[k] || it[k] === 0 ? it[k] : '');
      input.addEventListener('input', () => {
        draft.items[i][k] = k === 'name' || k === 'amount' ? input.value : num(input.value);
        renderLabelTotal();
      });
    });
    row.querySelector('.item__del').addEventListener('click', () => {
      draft.items.splice(i, 1);
      renderItems();
    });
    return row;
  }
  function renderItems() {
    el.items.replaceChildren(...draft.items.map(itemRow));
    renderLabelTotal();
  }
  function renderLabelTotal() {
    const t = totals(draft.items);
    el.labelTotal.innerHTML = `
      <dt>エネルギー</dt><dd>${fmt(t.kcal)} kcal</dd>
      <dt>たんぱく質</dt><dd>${round1(t.p)} g</dd>
      <dt>脂質</dt><dd>${round1(t.f)} g</dd>
      <dt>炭水化物</dt><dd>${round1(t.c)} g</dd>`;
  }

  /* 補足（自然言語）: 書いた順に draft.notes に積み、毎回まとめて Claude に渡す */
  const hasEstimate = () => draft && draft.items.some((it) => it.name || it.kcal);
  function renderNotes() {
    const notes = draft ? draft.notes || [] : [];
    el.notesList.hidden = !notes.length;
    el.notesList.replaceChildren(...notes.map((n, i) => {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = n;
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', 'この補足を消す');
      del.addEventListener('click', () => { draft.notes.splice(i, 1); renderNotes(); });
      li.append(text, del);
      return li;
    }));
    // 写真も推定もないときは、文章だけで推定する入口になる
    const textOnly = !draftBlob && !draft?.photo && !hasEstimate();
    el.hintLabel.textContent = textOnly ? '食べたものを文章で書く' : '写真で分からないことを書く';
    el.hintInput.placeholder = textOnly
      ? '例：牛丼の並盛に生卵、味噌汁。紅しょうがたっぷり'
      : '例：ご飯は大盛り。中身は豚肉。ドレッシングは半分だけかけた';
    el.reanalyzeBtn.textContent = textOnly ? '文章から推定' : '補足して再計算';
  }
  // Claude からの質問。選択肢を押すとその答えを補足に足して、すぐ再計算する
  function normalizeQuestions(list) {
    return (Array.isArray(list) ? list : []).map((q) => {
      if (typeof q === 'string') return { question: q.trim(), options: [] };
      if (!q || typeof q !== 'object') return null;
      const options = (Array.isArray(q.options) ? q.options : []).map((o) => String(o).trim()).filter(Boolean).slice(0, 4);
      return { question: String(q.question || '').trim(), options };
    }).filter((q) => q && q.question).slice(0, 3);
  }
  function renderQuestions(questions) {
    el.questions.hidden = !questions.length;
    el.questions.replaceChildren(...questions.map((q) => {
      const box = document.createElement('div');
      box.className = 'question';
      const title = document.createElement('p');
      title.className = 'question__text';
      title.textContent = q.question;
      const opts = document.createElement('div');
      opts.className = 'question__options';
      q.options.forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'choice';
        b.textContent = o;
        b.addEventListener('click', () => answer(q.question, o));
        opts.append(b);
      });
      // 選択肢にない答えは文章で書く
      const other = document.createElement('button');
      other.type = 'button';
      other.className = 'choice choice--other';
      other.textContent = q.options.length ? 'その他（書く）' : '答えを書く';
      other.addEventListener('click', () => {
        const prefix = `${q.question} → `;
        const cur = el.hintInput.value.trim();
        el.hintInput.value = cur ? `${cur}\n${prefix}` : prefix;
        el.hintInput.focus();
        el.hintInput.setSelectionRange(el.hintInput.value.length, el.hintInput.value.length);
        box.remove();
        if (!el.questions.querySelector('.question')) el.questions.hidden = true;
      });
      opts.append(other);
      box.append(title, opts);
      return box;
    }));
  }
  function answer(question, choice) {
    if (!draft || analyzing) return;
    draft.notes = (draft.notes || []).concat(`${question} → ${choice}`).slice(-10);
    renderNotes();
    runAnalysis();
  }
  function takeHint() {
    const text = el.hintInput.value.trim();
    if (!text || !draft) return false;
    // 「質問 → 」だけで答えが空の行は捨てる
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/→\s*$/.test(l));
    if (!lines.length) return false;
    draft.notes = (draft.notes || []).concat(lines.join('。')).slice(-10);
    el.hintInput.value = '';
    renderNotes();
    return true;
  }

  async function runAnalysis() {
    if (!draft) return;
    takeHint();
    const hasPhoto = !!draftBlob;
    const notes = draft.notes || [];
    if (!hasPhoto && !notes.length) { el.hintInput.focus(); toast('食べたものや補足を文章で書いてください'); return; }
    const kind = engineKind(hasPhoto);
    if (kind === 'none') { renderEngine(); toast('解析の準備ができていません。手で入力するか、設定で API キーを入れてください'); return; }
    if (analyzing) analyzing.abort();
    const ctl = new AbortController();
    analyzing = ctl;
    el.status.hidden = false;
    el.statusText.textContent = hasPhoto
      ? '写真を解析しています…（30秒ほどかかることがあります）'
      : '補足をもとに計算しています…';
    el.aiNote.hidden = true;
    renderQuestions([]);
    el.reanalyzeBtn.disabled = true;
    el.saveBtn.disabled = true;
    const target = draft;
    try {
      // 2回目以降は前回の推定を渡し、補足のぶんだけ直してもらう
      const previous = hasEstimate() ? draft.items : null;
      const prompt = PROMPT({ hasPhoto, notes, previous });
      const result = kind === 'claude'
        ? await analyzeWithClaude(prompt, draftBlob, ctl.signal)
        : await analyzeWithApiKey(prompt, draftBlob, ctl.signal);
      if (draft !== target) return;
      const dishes = Array.isArray(result && result.dishes) ? result.dishes : [];
      const items = dishes.map(normalizeItem).filter(Boolean);
      if (items.length || !previous) draft.items = items;
      const conf = { high: '確度：高', medium: '確度：中', low: '確度：低（量を確かめてください）' }[result && result.confidence] || '';
      const note = result && typeof result.note === 'string' ? result.note : '';
      el.aiNote.textContent = [conf, note].filter(Boolean).join('　');
      el.aiNote.hidden = !el.aiNote.textContent;
      renderQuestions(normalizeQuestions(result && result.questions));
      if (!items.length) toast('食べ物を見つけられませんでした。手で入力できます');
      renderItems();
      renderNotes();
    } catch (e) {
      if (!(e instanceof AnalyzeError && e.quiet)) toast(e.message || '解析に失敗しました');
    } finally {
      if (analyzing === ctl) analyzing = null;
      el.status.hidden = true;
      el.reanalyzeBtn.disabled = false;
      el.saveBtn.disabled = false;
    }
  }

  async function onPhoto(file) {
    if (!file) return;
    if (!/^image\//.test(file.type) && file.type) { toast('画像ファイルを選んでください'); return; }
    let img;
    try { img = await loadImage(file); } catch (e) { toast('この画像は開けませんでした（HEIC の場合はカメラ設定で「互換性優先」にしてください）'); return; }
    const sendCanvas = drawScaled(img, 1280, false);
    const thumbCanvas = drawScaled(img, 240, true);
    if (img.close) img.close();
    draftBlob = await toBlob(sendCanvas, 0.85);
    const thumb = thumbCanvas.toDataURL('image/jpeg', 0.72);
    const now = new Date();
    const date = currentDay;
    openEditor({
      id: uid(), date, time: hm(now), type: guessType(now), items: [], photo: thumb,
      notes: takePreNote(), createdAt: now.toISOString(), updatedAt: now.toISOString(),
    }, true);
    runAnalysis();
  }

  function takePreNote() {
    const text = el.preNote.value.trim();
    el.preNote.value = '';
    return text ? [text] : [];
  }

  // 手で入力：撮る前の補足欄に書いてあれば、その文章から推定する
  function startManual() {
    draftBlob = null;
    const now = new Date();
    const notes = takePreNote();
    openEditor({
      id: uid(), date: currentDay, time: hm(now), type: guessType(now),
      items: notes.length ? [] : [{ name: '', amount: '', kcal: 0, p: 0, f: 0, c: 0 }], photo: '',
      notes, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    }, true);
    if (notes.length && engineKind(false) !== 'none') { runAnalysis(); return; }
    if (!draft.items.length) draft.items.push({ name: '', amount: '', kcal: 0, p: 0, f: 0, c: 0 });
    renderItems();
    renderNotes();
    el.hintInput.focus({ preventScroll: true });
  }

  function saveDraft() {
    if (!draft) return;
    takeHint();   // 再計算せずに書いた補足もメモとして残す
    const items = draft.items.map(normalizeItem).filter((it) => it.name || it.kcal);
    if (!items.length) { toast('品目を1つ以上入れてください'); return; }
    const { isNew, ...rest } = draft;
    const meal = normalizeMeal(Object.assign(rest, { items, time: el.mealTime.value || rest.time, updatedAt: new Date().toISOString() }));
    const i = meals.findIndex((m) => m.id === meal.id);
    if (i > -1) meals[i] = meal; else meals.push(meal);
    persist();
    pushMeal(meal);
    closeEditor();
    renderDay();
    renderWeek();
    toast(isNew ? `${TYPES[meal.type]}を記録しました（${fmt(totals(meal.items).kcal)} kcal）` : '更新しました');
  }

  function deleteDraft() {
    if (!draft || draft.isNew) return;
    // 確認ダイアログが使えない環境もあるので、ボタンを2回押して消す
    if (!el.deleteBtn.dataset.armed) {
      el.deleteBtn.dataset.armed = '1';
      el.deleteBtn.textContent = 'もう一度押すと削除';
      return;
    }
    const id = draft.id;
    meals = meals.filter((m) => m.id !== id);
    persist();
    dropMeal(id);
    closeEditor();
    renderDay();
    renderWeek();
    toast('削除しました');
  }

  /* ---------- 商品名で記録 ---------- */
  const productKey = (name) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  // 前に同じ商品を記録していれば、その値をそのまま使う（解析を待たずに済む）
  function findProduct(name) {
    const key = productKey(name);
    return meals.filter((m) => m.product && productKey(m.product) === key)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
  }
  function renderProductList() {
    const seen = new Set();
    const names = [];
    meals.filter((m) => m.product).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).forEach((m) => {
      const key = productKey(m.product);
      if (seen.has(key) || names.length >= 30) return;
      seen.add(key);
      names.push(m.product);
    });
    el.productList.replaceChildren(...names.map((n) => Object.assign(document.createElement('option'), { value: n })));
  }
  function addMeal(meal) {
    meals.push(meal);
    persist();
    pushMeal(meal);
    renderDay();
    renderWeek();
  }

  async function recordProduct(name) {
    name = name.replace(/\s+/g, ' ').trim();
    if (!name) { el.productInput.focus(); return; }
    const now = new Date();
    const base = { id: uid(), date: currentDay, time: hm(now), type: guessType(now), photo: '', product: name,
      createdAt: now.toISOString(), updatedAt: now.toISOString() };

    const known = findProduct(name);
    if (known) {
      const meal = normalizeMeal(Object.assign(base, { items: known.items }));
      addMeal(meal);
      el.productInput.value = '';
      toast(`「${name}」を記録しました（${fmt(totals(meal.items).kcal)} kcal・前回と同じ値）`);
      return;
    }

    const kind = engineKind(false);
    if (kind === 'none') {
      // 調べられないときは名前だけ入れて手入力にする
      draftBlob = null;
      openEditor(Object.assign(base, { items: [{ name, amount: '1個', kcal: 0, p: 0, f: 0, c: 0 }] }), true);
      toast('商品を調べるには設定で API キーが必要です。カロリーを手で入れてください');
      el.productInput.value = '';
      return;
    }

    el.productBtn.disabled = true;
    el.productInput.disabled = true;
    el.productBtn.textContent = '調べ中…';
    try {
      const prompt = PRODUCT_PROMPT(name);
      const result = kind === 'claude' ? await analyzeWithClaude(prompt, null) : await analyzeWithApiKey(prompt, null);
      const items = (Array.isArray(result && result.dishes) ? result.dishes : []).map(normalizeItem).filter((it) => it.name);
      const note = result && typeof result.note === 'string' ? result.note : '';
      el.productInput.value = '';
      if (!items.length) {
        draftBlob = null;
        openEditor(Object.assign(base, { items: [{ name, amount: '1個', kcal: 0, p: 0, f: 0, c: 0 }] }), true);
        toast(note || 'この商品は見つかりませんでした。カロリーを手で入れてください');
        return;
      }
      const meal = normalizeMeal(Object.assign(base, { items }));
      if (result.confidence === 'low') {
        // 自信がないときは記録前に確かめてもらう
        draftBlob = null;
        openEditor(meal, true);
        el.aiNote.textContent = `確度：低（値を確かめてください）　${note}`;
        el.aiNote.hidden = false;
        return;
      }
      addMeal(meal);
      const tag = result.confidence === 'high' ? '' : '・推定';
      toast(`「${items[0].name}」を記録しました（${fmt(totals(items).kcal)} kcal${tag}）`);
    } catch (e) {
      if (!(e instanceof AnalyzeError && e.quiet)) toast(e.message || '商品を調べられませんでした');
    } finally {
      el.productBtn.disabled = false;
      el.productInput.disabled = false;
      el.productBtn.textContent = '記録';
    }
  }

  /* ---------- 1日の表示 ---------- */
  const goalOf = (key) => (settings.goal * PFC_RATIO[key][0]) / PFC_RATIO[key][1];

  function renderDay() {
    const isToday = currentDay === today();
    el.dayLabel.textContent = isToday ? `今日・${dayText(currentDay)}` : dayText(currentDay);
    el.dayInput.value = currentDay;
    el.todayBtn.hidden = isToday;
    el.nextDay.disabled = currentDay >= today();
    renderProductList();

    const list = mealsOn(currentDay);
    const t = totals(list.flatMap((m) => m.items));
    const goal = settings.goal;
    const ratio = goal ? t.kcal / goal : 0;
    const circ = 2 * Math.PI * 52;
    el.ringValue.style.strokeDasharray = String(circ);
    el.ringValue.style.strokeDashoffset = String(circ * (1 - Math.min(1, ratio)));
    el.ring.classList.toggle('is-over', ratio > 1);
    el.ring.setAttribute('aria-label', `${fmt(t.kcal)} kcal / 目標 ${fmt(goal)} kcal`);
    el.eatenKcal.textContent = fmt(t.kcal);
    el.goalKcal.textContent = fmt(goal);
    const left = goal - t.kcal;
    el.remain.classList.toggle('is-over', left < 0);
    el.remain.innerHTML = left >= 0 ? `あと<strong>${fmt(left)}</strong>kcal` : `<strong>${fmt(-left)}</strong>kcal オーバー`;

    el.meters.replaceChildren(...[['p', 'たんぱく質'], ['f', '脂質'], ['c', '炭水化物']].map(([k, label]) => {
      const target = goalOf(k);
      const v = t[k];
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <div class="meter__row"><span>${label}</span><span>${round(v)} / ${round(target)} g</span></div>
        <div class="meter__bar"><div class="meter__fill"></div></div>`;
      const fill = wrap.querySelector('.meter__fill');
      fill.style.width = `${Math.min(100, (v / target) * 100)}%`;
      fill.classList.toggle('is-over', v > target * 1.15);
      return wrap;
    }));

    if (!list.length) {
      el.meals.innerHTML = `<div class="empty"><strong>${isToday ? 'まだ今日の記録はありません' : 'この日の記録はありません'}</strong>食事の前に「写真を撮る」を押すと、カロリーと PFC を推定して記録できます</div>`;
      return;
    }
    const groups = Object.keys(TYPES).map((type) => [type, list.filter((m) => m.type === type)]).filter(([, l]) => l.length);
    el.meals.replaceChildren(...groups.map(([type, l]) => {
      const g = document.createElement('div');
      g.className = 'meal-group';
      const h = document.createElement('h3');
      h.innerHTML = `${TYPES[type]}<span>${fmt(totals(l.flatMap((m) => m.items)).kcal)} kcal</span>`;
      g.append(h);
      l.forEach((m) => g.append(mealCard(m)));
      return g;
    }));
  }

  function mealCard(m) {
    const t = totals(m.items);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'meal';
    const thumb = m.photo ? document.createElement('img') : document.createElement('div');
    thumb.className = 'meal__thumb';
    if (m.photo) { thumb.src = m.photo; thumb.alt = ''; } else thumb.textContent = m.product ? '商品' : '手入力';
    const body = document.createElement('div');
    body.className = 'meal__body';
    const names = document.createElement('div');
    names.className = 'meal__names';
    names.textContent = m.items.map((it) => it.name || '（名前なし）').join('、');
    const sub = document.createElement('div');
    sub.className = 'meal__sub';
    sub.textContent = `${m.time}　P ${round(t.p)}g・F ${round(t.f)}g・C ${round(t.c)}g`;
    body.append(names, sub);
    if (m.notes.length) {
      const memo = document.createElement('div');
      memo.className = 'meal__sub meal__memo';
      memo.textContent = `補足：${m.notes.join(' / ')}`;
      body.append(memo);
    }
    const kcal = document.createElement('div');
    kcal.className = 'meal__kcal';
    kcal.innerHTML = `${fmt(t.kcal)}<small>kcal</small>`;
    b.append(thumb, body, kcal);
    b.addEventListener('click', () => { draftBlob = null; openEditor(m, false); });
    return b;
  }

  /* ---------- 推移 ---------- */
  function renderWeek() {
    const days = Array.from({ length: 7 }, (_, i) => addDays(today(), i - 6));
    const rows = days.map((d) => {
      const list = mealsOn(d);
      return { d, n: list.length, ...totals(list.flatMap((m) => m.items)) };
    });
    const recorded = rows.filter((r) => r.n);
    el.weekAvg.innerHTML = recorded.length
      ? `記録した${recorded.length}日の平均 <strong>${fmt(recorded.reduce((s, r) => s + r.kcal, 0) / recorded.length)} kcal</strong>`
      : '';

    // 棒グラフ（1系列なので凡例なし。目標は破線）
    const W = 340, H = 180, top = 18, bottom = 30, left = 8, right = 8;
    const max = Math.max(settings.goal * 1.2, ...rows.map((r) => r.kcal));
    const y = (v) => top + (H - top - bottom) * (1 - v / max);
    const step = (W - left - right) / 7;
    const bw = Math.min(28, step * 0.55);
    const base = y(0);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="直近7日の摂取カロリー">`;
    svg += `<line class="grid" x1="${left}" x2="${W - right}" y1="${base}" y2="${base}"></line>`;
    svg += `<line class="goal-line" x1="${left}" x2="${W - right}" y1="${y(settings.goal)}" y2="${y(settings.goal)}"></line>`;
    svg += `<text x="${W - right}" y="${y(settings.goal) - 4}" text-anchor="end">目標 ${fmt(settings.goal)}</text>`;
    rows.forEach((r, i) => {
      const cx = left + step * i + step / 2;
      const h = Math.max(0, base - y(r.kcal));
      const over = r.kcal > settings.goal;
      const rad = Math.min(4, h / 2, bw / 2);
      const x0 = cx - bw / 2, y0 = base - h;
      // 上の角だけ丸め、下は基準線に揃える
      const path = h > 0
        ? `M${x0},${base} V${y0 + rad} Q${x0},${y0} ${x0 + rad},${y0} H${x0 + bw - rad} Q${x0 + bw},${y0} ${x0 + bw},${y0 + rad} V${base} Z`
        : '';
      const pd = parseYmd(r.d);
      svg += `<g><rect class="bar-hit" data-day="${r.d}" tabindex="0" x="${cx - step / 2}" y="${top}" width="${step}" height="${H - top}"><title>${dayText(r.d)} ${fmt(r.kcal)} kcal</title></rect>`;
      if (path) svg += `<path class="bar${over ? ' is-over' : ''}" d="${path}"></path>`;
      svg += `</g>`;
      if (r.d === currentDay || i === 6) {
        if (r.kcal) svg += `<text class="val" x="${cx}" y="${y0 - 4}" text-anchor="middle">${fmt(r.kcal)}</text>`;
      }
      svg += `<text x="${cx}" y="${H - 14}" text-anchor="middle">${pd.getDate()}</text>`;
      svg += `<text x="${cx}" y="${H - 2}" text-anchor="middle">${WEEKDAYS[pd.getDay()]}</text>`;
    });
    svg += '</svg>';
    el.weekChart.innerHTML = svg;
    el.weekChart.querySelectorAll('.bar-hit').forEach((hit) => {
      const open = () => { currentDay = hit.dataset.day; renderDay(); showView('day'); };
      hit.addEventListener('click', open);
      hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });

    el.weekTable.tBodies[0].innerHTML = rows.slice().reverse().map((r) => `
      <tr>
        <td>${dayText(r.d)}</td>
        <td class="${r.kcal > settings.goal ? 'is-over' : ''}">${r.n ? fmt(r.kcal) : '—'}</td>
        <td>${r.n ? round(r.p) : '—'}</td><td>${r.n ? round(r.f) : '—'}</td><td>${r.n ? round(r.c) : '—'}</td>
        <td>${r.n}</td>
      </tr>`).join('');
  }

  /* ---------- 設定 ---------- */
  function calcGoal() {
    const p = {
      sex: el.pSex.value, age: num(el.pAge.value), height: num(el.pHeight.value), weight: num(el.pWeight.value),
      activity: parseFloat(el.pActivity.value) || 1.75, plan: parseFloat(el.pPlan.value) || 0,
    };
    settings.profile = p;
    if (!p.age || !p.height || !p.weight) { el.calcOut.textContent = '年齢・身長・体重を入れると目安が出ます'; return 0; }
    // Mifflin-St Jeor 式で基礎代謝を出し、活動量を掛ける
    const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === 'male' ? 5 : -161);
    const goal = Math.max(1200, Math.round((bmr * p.activity + p.plan) / 10) * 10);
    el.calcOut.innerHTML = `基礎代謝 約${fmt(bmr)} kcal → 目安 <strong>${fmt(goal)}</strong> kcal/日`;
    return goal;
  }
  function renderSettings() {
    el.goalInput.value = settings.goal;
    const p = settings.profile || {};
    if (p.sex) el.pSex.value = p.sex;
    if (p.age) el.pAge.value = p.age;
    if (p.height) el.pHeight.value = p.height;
    if (p.weight) el.pWeight.value = p.weight;
    if (p.activity) el.pActivity.value = String(p.activity);
    if (p.plan !== undefined) el.pPlan.value = String(p.plan);
    calcGoal();
    el.apiKey.value = readText(API_KEY_KEY);
    renderEngine();
    const photos = meals.filter((m) => m.photo).length;
    el.dataState.textContent = `記録 ${meals.length}件（写真付き ${photos}件）。${cloud.db ? 'claude.ai のあなた専用の領域に保存しています。' : 'この端末のブラウザに保存しています。ときどきバックアップしてください。'}`;
  }
  function saveSettings() {
    writeJSON(SETTINGS_KEY, settings);
    pushSettings();
  }

  /* ---------- 書き出し・読み込み ---------- */
  async function saveFile(filename, data, type) {
    const saver = window.claude && typeof window.claude.use === 'function'
      ? await window.claude.use('downloads').catch(() => null)
      : null;
    if (saver) {
      try { await saver.save({ filename, data }); toast('書き出しました'); } catch (e) { toast('書き出しをやめました'); }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  let xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxLoading) {
      xlsxLoading = new Promise((ok, ng) => {
        const s = document.createElement('script');
        s.src = XLSX_URL;
        s.onload = () => (window.XLSX ? ok(window.XLSX) : ng(new Error('xlsx')));
        s.onerror = () => { xlsxLoading = null; s.remove(); ng(new Error('xlsx')); };
        document.head.append(s);
      });
    }
    return xlsxLoading;
  }

  async function exportExcel() {
    const range = el.exportRange.value;
    const first = meals.reduce((d, m) => (m.date < d ? m.date : d), today());
    const from = range === 'all' ? first : addDays(today(), 1 - Number(range));
    const days = [];
    for (let d = from; d <= today(); d = addDays(d, 1)) days.push(d);
    const slash = (d) => d.replace(/-/g, '/');

    el.excelBtn.disabled = true;
    let XLSX;
    try { XLSX = await loadXlsx(); } catch (e) {
      el.excelBtn.disabled = false;
      toast('Excel 書き出しの部品を読み込めませんでした。通信できる状態で試してください');
      return;
    }
    try {
      const daily = [['日付', '曜日', '摂取kcal', '目標kcal', '目標との差', 'たんぱく質(g)', '脂質(g)', '炭水化物(g)', '食事の回数']];
      days.forEach((d) => {
        const list = mealsOn(d);
        const t = totals(list.flatMap((m) => m.items));
        daily.push(list.length
          ? [slash(d), WEEKDAYS[parseYmd(d).getDay()], round(t.kcal), settings.goal, round(t.kcal - settings.goal), round1(t.p), round1(t.f), round1(t.c), list.length]
          : [slash(d), WEEKDAYS[parseYmd(d).getDay()], null, settings.goal, null, null, null, null, 0]);
      });
      const detail = [['日付', '時刻', '区分', '品目', '量', 'kcal', 'たんぱく質(g)', '脂質(g)', '炭水化物(g)', '記録方法', '補足']];
      days.forEach((d) => mealsOn(d).forEach((m) => {
        const how = m.product ? '商品名' : m.photo ? '写真' : '手入力';
        m.items.forEach((it) => detail.push([slash(d), m.time, TYPES[m.type], it.name, it.amount, it.kcal, it.p, it.f, it.c, how, m.notes.join(' / ')]));
      }));

      const wb = XLSX.utils.book_new();
      const s1 = XLSX.utils.aoa_to_sheet(daily);
      s1['!cols'] = [12, 5, 10, 10, 11, 13, 10, 12, 10].map((w) => ({ wch: w }));
      const s2 = XLSX.utils.aoa_to_sheet(detail);
      s2['!cols'] = [12, 7, 7, 28, 16, 8, 13, 10, 12, 10, 40].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, s1, '日別');
      XLSX.utils.book_append_sheet(wb, s2, '食事の明細');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      await saveFile(`カロリー手帳_${from}_${today()}.xlsx`, buf,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } finally {
      el.excelBtn.disabled = false;
    }
  }

  async function exportData() {
    const text = JSON.stringify({ app: 'calorie-note', version: 1, settings: { goal: settings.goal, profile: settings.profile }, meals }, null, 2);
    await saveFile(`calorie-note-${today()}.json`, text, 'application/json');
  }
  async function importData(file) {
    try {
      const data = JSON.parse(await file.text());
      const incoming = (Array.isArray(data) ? data : data.meals || []).map(normalizeMeal).filter(Boolean);
      const ids = new Set(meals.map((m) => m.id));
      let added = 0;
      for (const m of incoming) {
        if (ids.has(m.id)) continue;
        meals.push(m);
        added += 1;
        pushMeal(m);
      }
      if (data.settings && data.settings.goal) {
        settings.goal = Math.round(num(data.settings.goal)) || settings.goal;
        settings.profile = data.settings.profile || settings.profile;
        saveSettings();
      }
      persist();
      renderAll();
      toast(`${added}件を読み込みました`);
    } catch (e) {
      toast('読み込めませんでした。書き出したバックアップ（.json）を選んでください');
    }
  }

  /* ---------- 画面の切り替え ---------- */
  function showView(name) {
    el.tabs.forEach((t) => {
      const on = t.dataset.view === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    el.views.forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
    if (name === 'week') renderWeek();
    if (name === 'settings') renderSettings();
    if (name === 'day') renderDay();
    window.scrollTo(0, 0);
  }
  function renderAll() { renderDay(); renderWeek(); renderSettings(); }

  /* ---------- イベント ---------- */
  el.tabs.forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  el.prevDay.addEventListener('click', () => { currentDay = addDays(currentDay, -1); renderDay(); });
  el.nextDay.addEventListener('click', () => { if (currentDay < today()) { currentDay = addDays(currentDay, 1); renderDay(); } });
  el.todayBtn.addEventListener('click', () => { currentDay = today(); renderDay(); });
  el.dayInput.addEventListener('change', () => { if (el.dayInput.value) { currentDay = el.dayInput.value; renderDay(); } });

  [el.cameraInput, el.libraryInput].forEach((input) => input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';
    onPhoto(file);
  }));
  el.manualBtn.addEventListener('click', startManual);
  el.productForm.addEventListener('submit', (e) => { e.preventDefault(); recordProduct(el.productInput.value); });
  el.excelBtn.addEventListener('click', exportExcel);
  el.mealType.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b || !draft) return;
    draft.type = b.dataset.type;
    renderType();
  });
  el.addItem.addEventListener('click', () => {
    draft.items.push({ name: '', amount: '', kcal: 0, p: 0, f: 0, c: 0 });
    renderItems();
    const inputs = el.items.querySelectorAll('.item:last-child input');
    if (inputs[0]) inputs[0].focus();
  });
  el.reanalyzeBtn.addEventListener('click', runAnalysis);
  // Enter で送信、Shift+Enter で改行（変換確定の Enter は除く）
  el.hintInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); runAnalysis(); }
  });
  el.preNote.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) e.preventDefault(); });
  el.stopBtn.addEventListener('click', () => { if (analyzing) analyzing.abort(); });
  el.cancelBtn.addEventListener('click', closeEditor);
  el.saveBtn.addEventListener('click', saveDraft);
  el.deleteBtn.addEventListener('click', deleteDraft);

  el.goalForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const g = Math.round(num(el.goalInput.value));
    if (g < 800 || g > 6000) { toast('目標は 800〜6000 kcal の範囲で入れてください'); return; }
    settings.goal = g;
    calcGoal();
    saveSettings();
    renderDay();
    toast('目標を保存しました');
  });
  [el.pSex, el.pAge, el.pHeight, el.pWeight, el.pActivity, el.pPlan].forEach((i) => i.addEventListener('input', calcGoal));
  el.applyCalc.addEventListener('click', () => {
    const g = calcGoal();
    if (!g) return;
    settings.goal = g;
    el.goalInput.value = g;
    saveSettings();
    renderDay();
    toast(`目標を ${fmt(g)} kcal にしました`);
  });
  el.keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = el.apiKey.value.trim();
    if (key && !key.startsWith('sk-ant-')) { toast('API キーは「sk-ant-」で始まる文字列です'); return; }
    writeText(API_KEY_KEY, key);
    renderEngine();
    toast(key ? 'キーを保存しました' : 'キーを消しました');
  });
  el.clearKey.addEventListener('click', () => {
    writeText(API_KEY_KEY, '');
    el.apiKey.value = '';
    renderEngine();
    toast('キーを消しました');
  });
  el.exportBtn.addEventListener('click', exportData);
  el.importInput.addEventListener('change', () => {
    const file = el.importInput.files && el.importInput.files[0];
    el.importInput.value = '';
    if (file) importData(file);
  });

  // 日付をまたいで開きっぱなしでも「今日」がずれないように
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderDay();
  });

  renderAll();
  detectSample();
  connectCloud();
})();
