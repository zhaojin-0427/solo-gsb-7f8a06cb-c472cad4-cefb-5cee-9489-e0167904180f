/* 原生 JS：编辑规则 / HTML，Shadow DOM 预览，调用服务端层叠判定 API。 */

const $ = (sel) => document.querySelector(sel);

const htmlEditor = $('#htmlEditor');
const htmlErrorsBox = $('#htmlErrors');
const rulesList = $('#rulesList');
const addRuleBtn = $('#addRuleBtn');
const propSelect = $('#propSelect');
const analysisBox = $('#analysis');
const layerOrderInfo = $('#layerOrderInfo');
const selectedInfoBox = $('#selectedInfo');
const locatorInfo = $('#locatorInfo');
const exampleSelect = $('#exampleSelect');
const loadExampleBtn = $('#loadExampleBtn');
const previewHost = $('#previewHost');
const simplifyBtn = $('#simplifyBtn');
const simplifyModal = $('#simplifyModal');
const simplifyModalBody = $('#simplifyModalBody');
const simplifyCancelBtn = $('#simplifyCancelBtn');
const simplifyConfirmBtn = $('#simplifyConfirmBtn');
const toast = $('#toast');

const shadow = previewHost.attachShadow({ mode: 'open' });
let userRoot = null;
let lastHovered = null;
let uidSeq = 1;

const DEFAULTS = { color: '#333333', 'background-color': 'transparent', 'font-size': '14px' };
const PROPS = ['color', 'background-color', 'font-size'];

const state = {
  html: '',
  rules: [],            // { uid, selector, property, value, layer, important }
  selectedPath: null,
  property: 'color',
  styles: {},
  lastRenderedHtml: null,
};

let computeSeq = 0;
let analyzeSeq = 0;
let locatorSeq = 0;

/* ---------------- 工具 ---------------- */

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

/* ---------------- 路径与预览 ---------------- */

function pathOf(el) {
  const parts = [];
  let cur = el;
  while (cur && cur !== userRoot) {
    const parent = cur.parentElement;
    if (!parent) return null;
    parts.unshift([...parent.children].indexOf(cur));
    cur = parent;
  }
  return parts.join('.');
}

function elByPath(path) {
  if (path == null) return null;
  let cur = userRoot;
  for (const idx of path.split('.').map(Number)) {
    cur = cur?.children[idx];
    if (!cur) return null;
  }
  return cur;
}

function renderPreview(html) {
  shadow.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = `
    #userRoot { all: revert; }
    #userRoot div, #userRoot section, #userRoot p, #userRoot span {
      border: 1px dotted rgba(40, 60, 90, 0.22);
      padding: 4px 6px;
      margin: 3px;
      cursor: pointer;
      border-radius: 3px;
      min-height: 1em;
      font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      display: revert;
    }
    #userRoot p { display: block; }
    #userRoot span { display: inline; padding: 0 4px; }
    #userRoot div.hovered, #userRoot section.hovered,
    #userRoot p.hovered, #userRoot span.hovered {
      outline: 2px dashed #4a7ee0;
      outline-offset: -1px;
    }
    #userRoot div.picked, #userRoot section.picked,
    #userRoot p.picked, #userRoot span.picked {
      outline: 2px solid #e8602c;
      outline-offset: -1px;
    }
  `;
  userRoot = document.createElement('div');
  userRoot.id = 'userRoot';
  userRoot.innerHTML = html;
  shadow.append(style, userRoot);
  lastHovered = null;
}

function applyStyles() {
  if (!userRoot) return;
  userRoot.querySelectorAll('div, section, p, span').forEach((el) => {
    const path = pathOf(el);
    const won = state.styles[path] || {};
    for (const prop of PROPS) {
      el.style.setProperty(prop, won[prop] ?? DEFAULTS[prop]);
    }
  });
}

function markPicked(path) {
  userRoot?.querySelectorAll('.picked').forEach((el) => el.classList.remove('picked'));
  if (path != null) elByPath(path)?.classList.add('picked');
}

function describeElement(el) {
  if (!el) return '未选择元素';
  let name = el.tagName.toLowerCase();
  if (el.id) name += `#${el.id}`;
  [...el.classList].forEach((c) => { name += `.${c}`; });
  return `当前元素：<strong>${escapeHtml(name)}</strong>　路径 <code>${escapeHtml(pathOf(el))}</code>`;
}

/* 事件委托（shadow root 不会随 innerHTML 重置而丢失监听） */
shadow.addEventListener('click', (e) => {
  const el = e.target;
  if (!(el instanceof Element) || !['DIV', 'SECTION', 'P', 'SPAN'].includes(el.tagName)) return;
  e.preventDefault();
  state.selectedPath = pathOf(el);
  markPicked(state.selectedPath);
  selectedInfoBox.innerHTML = describeElement(el);
  analyze();
  locate();
});

shadow.addEventListener('mouseover', (e) => {
  const el = e.target;
  if (!(el instanceof Element) || !['DIV', 'SECTION', 'P', 'SPAN'].includes(el.tagName)) return;
  if (lastHovered && lastHovered !== el) lastHovered.classList.remove('hovered');
  el.classList.add('hovered');
  lastHovered = el;
});

shadow.addEventListener('mouseout', (e) => {
  const el = e.target;
  if (el instanceof Element && el.classList?.contains('hovered') && !el.contains(e.relatedTarget)) {
    el.classList.remove('hovered');
    if (lastHovered === el) lastHovered = null;
  }
});

/* ---------------- 规则编辑 ---------------- */

function ruleRowHtml(rule, idx) {
  return `
  <div class="rule-card" data-uid="${rule.uid}">
    <div class="rule-title">
      <span>规则 #${idx + 1}</span>
    </div>
    <div class="rule-grid">
      <input type="text" data-field="selector" placeholder="选择器，如 #main .box > p"
             value="${escapeHtml(rule.selector)}">
      <select data-field="property">
        ${PROPS.map((p) => `<option value="${p}"${p === rule.property ? ' selected' : ''}>${p}</option>`).join('')}
      </select>
      <input type="text" data-field="value" placeholder="值，如 red / 16px"
             value="${escapeHtml(rule.value)}">
      <input type="text" data-field="layer" placeholder="层名（可选）"
             value="${escapeHtml(rule.layer)}">
      <label class="important-label">
        <input type="checkbox" data-field="important"${rule.important ? ' checked' : ''}>!important
      </label>
      <button type="button" class="btn-icon" data-action="delete">删除</button>
    </div>
    <div class="rule-error" hidden></div>
  </div>`;
}

function renderRules() {
  rulesList.innerHTML = state.rules.map((r, i) => ruleRowHtml(r, i)).join('');
  bindRuleEvents();
}

function bindRuleEvents() {
  rulesList.querySelectorAll('.rule-card').forEach((card) => {
    const uid = Number(card.dataset.uid);
    const rule = state.rules.find((r) => r.uid === uid);
    if (!rule) return;
    card.querySelectorAll('[data-field]').forEach((input) => {
      const field = input.dataset.field;
      const evt = input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input';
      input.addEventListener(evt, () => {
        rule[field] = input.type === 'checkbox' ? input.checked : input.value;
        scheduleCompute();
      });
    });
    card.querySelector('[data-action="delete"]').addEventListener('click', () => {
      state.rules = state.rules.filter((r) => r.uid !== uid);
      renderRules();
      renderRuleErrors([]);
      scheduleCompute();
    });
  });
}

function addRule(partial = {}) {
  state.rules.push({
    uid: uidSeq++,
    selector: '',
    property: 'color',
    value: '',
    layer: '',
    important: false,
    ...partial,
  });
}

function renderRuleErrors(ruleErrors) {
  const map = new Map(ruleErrors.map((e) => [e.index, e.messages]));
  rulesList.querySelectorAll('.rule-card').forEach((card, i) => {
    const box = card.querySelector('.rule-error');
    const msgs = map.get(i) || [];
    card.classList.toggle('has-error', msgs.length > 0);
    if (msgs.length) {
      box.hidden = false;
      box.innerHTML = msgs.map((m) => `<div>${escapeHtml(m)}</div>`).join('');
    } else {
      box.hidden = true;
      box.innerHTML = '';
    }
  });
}

addRuleBtn.addEventListener('click', () => {
  addRule();
  renderRules();
  rulesList.lastElementChild.querySelector('[data-field="selector"]').focus();
  scheduleCompute();
});

/* ---------------- 错误与层顺序展示 ---------------- */

function renderHtmlErrors(errors) {
  if (errors?.length) {
    htmlErrorsBox.hidden = false;
    htmlErrorsBox.innerHTML = errors.map((m) => `<div>${escapeHtml(m)}</div>`).join('');
  } else {
    htmlErrorsBox.hidden = true;
    htmlErrorsBox.innerHTML = '';
  }
}

function renderLayerOrder(layerOrder) {
  if (layerOrder?.length) {
    const chips = layerOrder.map((l) => `<span class="layer-chip">${escapeHtml(l)}</span>`).join(' → ');
    layerOrderInfo.innerHTML = `层顺序（按首次出现）：${chips}　<span class="badge nolayer">无层</span>`;
  } else {
    layerOrderInfo.textContent = '当前规则均为无层声明。';
  }
}

/* ---------------- 分析结果 ---------------- */

function renderAnalysis(data) {
  if (data.element == null) {
    analysisBox.innerHTML = `<p class="empty-tip">${escapeHtml(data.message || '请重新点击预览中的元素。')}</p>`;
    return;
  }

  const el = { tag: data.element.tag, id: data.element.id, classes: data.element.classes, path: data.element.path };
  let name = el.tag;
  if (el.id) name += `#${el.id}`;
  el.classes.forEach((c) => { name += `.${c}`; });
  selectedInfoBox.innerHTML = `当前元素：<strong>${escapeHtml(name)}</strong>　路径 <code>${escapeHtml(el.path)}</code>`;

  const winner = data.matched.find((d) => d.winner);
  let html;
  if (winner) {
    html = `<div class="computed-value">${escapeHtml(state.property)} 的胜出值：
      <code>${escapeHtml(winner.value)}</code>
      （来自规则 #${winner.ruleIndex + 1} <code>${escapeHtml(winner.selector)}</code>）</div>`;
  } else {
    html = `<div class="computed-value none">没有匹配 ${escapeHtml(state.property)} 的声明。
      不计继承与默认样式，因此该属性无计算值。</div>`;
  }

  if (data.matched.length) {
    html += data.matched.map((d) => {
      const layerBadge = d.layer
        ? `<span class="badge layer">层「${escapeHtml(d.layer)}」</span>`
        : `<span class="badge nolayer">无层</span>`;
      const impBadge = d.important ? `<span class="badge important">!important</span>` : '';
      return `
      <div class="decl ${d.winner ? 'winner' : ''}">
        <div class="decl-head">
          <span class="badge ${d.winner ? 'win' : 'lose'}">${d.winner ? '胜出' : '落败'}</span>
          <code>${escapeHtml(d.selector)}</code>
          <span class="arrow">→</span>
          <code>${escapeHtml(d.property)}: ${escapeHtml(d.value)}</code>
          ${layerBadge}${impBadge}
        </div>
        <div class="decl-meta">规则 #${d.ruleIndex + 1} · 特异性 (${d.specificity.join(', ')})
          （ID, 类, 类型）</div>
        ${d.reason ? `<div class="decl-reason">${escapeHtml(d.reason)}</div>` : ''}
      </div>`;
    }).join('');
  }
  analysisBox.innerHTML = html;
}

/* ---------------- API 调用 ---------------- */

const scheduleCompute = debounce(compute, 250);

async function compute() {
  const seq = ++computeSeq;
  let data;
  try {
    data = await postJson('/api/compute', { html: state.html, rules: state.rules });
  } catch (err) {
    showToast(`计算失败：${err.message}`);
    return;
  }
  if (seq !== computeSeq) return; // 已有更新的请求

  renderHtmlErrors(data.htmlErrors);
  renderRuleErrors(data.ruleErrors || []);
  renderLayerOrder(data.layerOrder);
  state.styles = data.styles || {};

  const htmlOk = !(data.htmlErrors && data.htmlErrors.length);
  if (htmlOk && state.html !== state.lastRenderedHtml) {
    renderPreview(state.html);
    state.lastRenderedHtml = state.html;
    if (state.selectedPath && elByPath(state.selectedPath)) {
      markPicked(state.selectedPath);
    } else {
      state.selectedPath = null;
      selectedInfoBox.textContent = '未选择元素';
    }
  }
  if (htmlOk) {
    applyStyles();
    if (state.selectedPath && elByPath(state.selectedPath)) {
      analyze();
      locate();
    } else {
      analysisBox.innerHTML = '<p class="empty-tip">点击预览中的元素后，此处展示匹配声明、胜出值与落败原因。</p>';
      renderLocator(null);
    }
  } else {
    renderLocator(null);
  }
}

async function analyze() {
  const seq = ++analyzeSeq;
  let data;
  try {
    data = await postJson('/api/analyze', {
      html: state.html,
      rules: state.rules,
      path: state.selectedPath,
      property: state.property,
    });
  } catch (err) {
    showToast(`分析失败：${err.message}`);
    return;
  }
  if (seq !== analyzeSeq) return;
  renderAnalysis(data);
}

/* ---------------- 唯一选择器 ---------------- */

async function locate() {
  if (!state.selectedPath) {
    renderLocator(null);
    return;
  }
  const seq = ++locatorSeq;
  let data;
  try {
    data = await postJson('/api/locator', { html: state.html, path: state.selectedPath });
  } catch (err) {
    if (seq === locatorSeq) renderLocator({ ok: false, message: `请求失败：${err.message}` });
    return;
  }
  if (seq !== locatorSeq) return;
  renderLocator(data);
}

function renderLocator(data) {
  if (!data) {
    locatorInfo.hidden = true;
    locatorInfo.innerHTML = '';
    return;
  }
  locatorInfo.hidden = false;
  if (data.ok) {
    locatorInfo.innerHTML = `
      <span class="locator-label">唯一选择器：</span>
      <code class="locator-selector" title="在整棵元素树中只命中当前元素（${data.segments} 段）">${escapeHtml(data.selector)}</code>
      <button type="button" class="btn-secondary locator-copy">复制</button>`;
    locatorInfo.querySelector('.locator-copy').addEventListener('click', () => copyLocator(data.selector));
  } else {
    locatorInfo.innerHTML = `
      <span class="locator-label">唯一选择器：</span>
      <span class="locator-fail">${escapeHtml(data.message || '无法生成唯一选择器。')}</span>`;
  }
}

async function copyLocator(selector) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(selector);
    } else {
      // 非安全上下文（如 http:// 局域网地址）的兜底复制方式
      const ta = document.createElement('textarea');
      ta.value = selector;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast('唯一选择器已复制');
  } catch {
    showToast('复制失败，请手动选择文本复制');
  }
}

/* ---------------- 等价精简 ---------------- */

let simplifyResult = null;

function idxListHtml(indices, cls) {
  if (!indices.length) return '<span class="simp-none">无</span>';
  return indices.map((i) => `<span class="idx-chip ${cls}">#${i + 1}</span>`).join('');
}

function layerChips(order) {
  if (!order?.length) return '<span class="simp-none">无有层规则（均为无层声明）</span>';
  return order.map((l) => `<span class="layer-chip">${escapeHtml(l)}</span>`).join(' → ');
}

function ruleSummary(i) {
  const r = state.rules[i];
  if (!r) return '';
  const imp = r.important ? ' <span class="badge important">!important</span>' : '';
  const layer = r.layer
    ? `<span class="badge layer">层「${escapeHtml(r.layer)}」</span>`
    : '<span class="badge nolayer">无层</span>';
  return `<code>${escapeHtml(r.selector)}</code> <span class="arrow">→</span>
    <code>${escapeHtml(r.property)}: ${escapeHtml(r.value)}</code> ${layer}${imp}`;
}

function openSimplifyModal() {
  simplifyModal.hidden = false;
}

function closeSimplifyModal() {
  simplifyModal.hidden = true;
  simplifyResult = null;
}

function renderSimplifyError(data) {
  simplifyConfirmBtn.hidden = true;
  simplifyCancelBtn.textContent = '知道了';
  const htmlErrors = (data.htmlErrors || []).map((m) => `<div>${escapeHtml(m)}</div>`).join('');
  const ruleErrors = (data.ruleErrors || [])
    .map((e) => e.messages.map((m) => `<div>规则 #${e.index + 1}：${escapeHtml(m)}</div>`).join(''))
    .join('');
  simplifyModalBody.innerHTML = `
    <div class="simp-error-title">无法进行等价精简（输入未被改动）</div>
    <div class="simp-error-msg">${escapeHtml(data.message || 'HTML 或规则不合法 / 超过规模上限。')}</div>
    ${htmlErrors ? `<div class="simp-error-list"><strong>HTML 错误：</strong>${htmlErrors}</div>` : ''}
    ${ruleErrors ? `<div class="simp-error-list"><strong>规则错误：</strong>${ruleErrors}</div>` : ''}`;
  openSimplifyModal();
}

function renderSimplifyResult(data) {
  simplifyResult = data;
  simplifyConfirmBtn.hidden = false;
  simplifyCancelBtn.textContent = '取消';

  const removedRows = data.removed.map((i) => `
    <li class="simp-rule removed">${idxListHtml([i], 'del')} ${ruleSummary(i)}</li>`).join('');
  const keptRows = data.kept.map((i) => `
    <li class="simp-rule kept">${idxListHtml([i], 'keep')} ${ruleSummary(i)}</li>`).join('');

  const layerChanged = JSON.stringify(data.originalLayerOrder) !== JSON.stringify(data.layerOrder);
  simplifyModalBody.innerHTML = `
    <p class="simp-summary">
      在 <strong>${data.ruleCount}</strong> 条原规则中保留
      <strong>${data.kept.length}</strong> 条、删除
      <strong>${data.removed.length}</strong> 条，即可保证全部
      ${data.elementCount} 个元素的 <code>color</code> /
      <code>background-color</code> / <code>font-size</code>
      胜出值（包括无声明）与原规则集完全一致。
    </p>
    <div class="simp-cols">
      <div class="simp-col">
        <div class="simp-col-title">保留的原规则序号</div>
        <div class="simp-idx-row">${idxListHtml(data.kept, 'keep')}</div>
      </div>
      <div class="simp-col">
        <div class="simp-col-title">删除的原规则序号</div>
        <div class="simp-idx-row">${idxListHtml(data.removed, 'del')}</div>
      </div>
    </div>
    <div class="simp-layers">
      <div><span class="simp-col-title">原层顺序：</span>${layerChips(data.originalLayerOrder)}</div>
      <div><span class="simp-col-title">新层顺序：</span>${layerChips(data.layerOrder)}
        ${layerChanged ? '<span class="simp-note">（按保留规则的层名首次出现重新计算）</span>' : '<span class="simp-note">（未变化）</span>'}</div>
    </div>
    <details class="simp-details">
      <summary>查看每条规则的去留</summary>
      <div class="simp-rule-list">
        <div class="simp-col-title">删除</div>
        ${removedRows || '<div class="simp-none">无删除规则</div>'}
        <div class="simp-col-title">保留</div>
        ${keptRows || '<div class="simp-none">无保留规则（全部声明均可删除）</div>'}
      </div>
    </details>
    <p class="simp-warn">确认后才会替换编辑区规则；取消则不做任何改动。</p>`;
  openSimplifyModal();
}

simplifyBtn.addEventListener('click', async () => {
  simplifyBtn.disabled = true;
  let data;
  try {
    data = await postJson('/api/simplify', { html: state.html, rules: state.rules });
  } catch (err) {
    renderSimplifyError({ message: `请求失败：${err.message}` });
    simplifyBtn.disabled = false;
    return;
  }
  simplifyBtn.disabled = false;
  if (!data.ok) {
    renderSimplifyError(data);
    return;
  }
  // 记录请求时刻的规则快照，确认时核对，避免序号与编辑区错配
  data.rulesSnapshot = state.rules.slice();
  renderSimplifyResult(data);
});

simplifyConfirmBtn.addEventListener('click', () => {
  if (!simplifyResult) return;
  if (state.rules.length !== simplifyResult.ruleCount
      || state.rules.some((r, i) => r !== simplifyResult.rulesSnapshot[i])) {
    showToast('规则在精简计算后已被修改，请重新执行等价精简');
    closeSimplifyModal();
    return;
  }
  const keptSet = new Set(simplifyResult.kept);
  state.rules = state.rules.filter((_, i) => keptSet.has(i));
  renderRules();
  renderRuleErrors([]);
  closeSimplifyModal();
  showToast('规则已按等价精简结果替换');
  compute();
});

simplifyCancelBtn.addEventListener('click', closeSimplifyModal);
simplifyModal.addEventListener('click', (e) => {
  if (e.target === simplifyModal) closeSimplifyModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !simplifyModal.hidden) closeSimplifyModal();
});

/* ---------------- 示例 ---------------- */

function loadExample(ex) {
  state.html = ex.html || '';
  state.rules = (ex.rules || []).map((r) => ({
    uid: uidSeq++,
    selector: r.selector || '',
    property: r.property || 'color',
    value: r.value || '',
    layer: r.layer || '',
    important: !!r.important,
  }));
  state.selectedPath = null;
  state.styles = {};
  state.lastRenderedHtml = null;
  htmlEditor.value = state.html;
  renderRules();
  selectedInfoBox.textContent = '未选择元素';
  renderLocator(null);
  compute();
}

async function init() {
  htmlEditor.addEventListener('input', () => {
    state.html = htmlEditor.value;
    scheduleCompute();
  });

  propSelect.addEventListener('change', () => {
    state.property = propSelect.value;
    if (state.selectedPath) analyze();
  });

  loadExampleBtn.addEventListener('click', () => {
    const ex = exampleSelect.selectedOptions[0]?.example;
    if (ex) loadExample(ex);
  });
  exampleSelect.addEventListener('change', () => {
    const ex = exampleSelect.selectedOptions[0]?.example;
    if (ex) loadExample(ex);
  });

  let examples = [];
  try {
    examples = await fetch('/api/examples').then((r) => r.json());
  } catch {
    /* 离线/异常时使用内置兜底示例 */
  }
  if (!examples.length) examples = [FALLBACK_EXAMPLE];

  examples.forEach((ex) => {
    const opt = document.createElement('option');
    opt.textContent = ex.title || ex.name || '示例';
    opt.example = ex;
    exampleSelect.append(opt);
  });
  loadExample(examples[0]);
}

const FALLBACK_EXAMPLE = {
  title: '内置示例',
  html: '<div id="main">\n  <p class="text">你好</p>\n</div>',
  rules: [{ selector: 'p', property: 'color', value: 'red', layer: '', important: false }],
};

init();
