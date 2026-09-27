/**
 * CSS 层叠判定引擎（服务端与测试共用，纯 ESM，无第三方依赖）。
 *
 * 支持范围：
 *  - HTML：仅 div / section / p / span 标签，id / class 属性与文本。
 *    属性值中的字符引用（&#32; / &#x20; / &amp; 等）按浏览器规则解码；
 *    元素树构造遵循浏览器 in-body 规则（如 p 被块级开始标签隐式闭合、
 *    孤立 </p> 生成空 p、多余结束标签被忽略、EOF 自动闭合未闭合标签），
 *    保证与预览（innerHTML）得到同一棵元素树与同一套路径。
 *  - 选择器：类型、#id、.class，以及后代（空格）与直接子代（>）组合。
 *  - 属性：color / background-color / font-size。
 *  - 层叠规则：
 *      1. !important 声明优先于普通声明；
 *      2. 普通声明：无层 > 有层；同有层时后出现的层优先；
 *      3. !important 声明：有层 > 无层；同有层时先出现的层优先；
 *      4. 层顺序按层名在规则列表中首次出现的位置确定；
 *      5. 同层（同重要级）依次比较 ID、类、类型选择器数量，再比较规则先后顺序（后者优先）；
 *      6. 不计继承与浏览器默认样式。
 */

export const ALLOWED_TAGS = ['div', 'section', 'p', 'span'];
export const ALLOWED_PROPS = ['color', 'background-color', 'font-size'];

const IDENT_RE = /^[A-Za-z_-][A-Za-z0-9_-]*$/;
const MAX_ERRORS = 10;

/* ------------------------------------------------------------------ */
/* 字符引用解码（与浏览器一致）                                          */
/* ------------------------------------------------------------------ */

/*
 * 命名字符引用表（常用子集）。未收录的名称保持原样——浏览器对未知引用同样原样保留。
 * Latin-1 集合（U+00A0–U+00FF）与 lt/gt/amp/quot 属于 HTML4 遗留引用，可省略分号；
 * 其余（如 &apos;）必须带分号才可解码。
 */
const LATIN1_REF_NAMES = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg' +
  ' plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest' +
  ' Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute' +
  ' Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc' +
  ' Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute' +
  ' ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide' +
  ' oslash ugrave uacute ucirc uuml yacute thorn yuml'
).split(' ');

const NAMED_REFS = new Map();
LATIN1_REF_NAMES.forEach((name, i) => NAMED_REFS.set(name, String.fromCodePoint(0xa0 + i)));
for (const [name, cp] of [
  ['lt', 0x3c], ['gt', 0x3e], ['amp', 0x26], ['quot', 0x22],
  ['LT', 0x3c], ['GT', 0x3e], ['AMP', 0x26], ['QUOT', 0x22],
  ['apos', 0x27], ['euro', 0x20ac], ['trade', 0x2122], ['hellip', 0x2026],
  ['ndash', 0x2013], ['mdash', 0x2014], ['lsquo', 0x2018], ['rsquo', 0x2019],
  ['ldquo', 0x201c], ['rdquo', 0x201d], ['sbquo', 0x201a], ['bdquo', 0x201e],
  ['dagger', 0x2020], ['Dagger', 0x2021], ['bull', 0x2022], ['permil', 0x2030],
  ['prime', 0x2032], ['Prime', 0x2033], ['larr', 0x2190], ['uarr', 0x2191],
  ['rarr', 0x2192], ['darr', 0x2193], ['harr', 0x2194], ['minus', 0x2212],
]) {
  NAMED_REFS.set(name, String.fromCodePoint(cp));
}
/** 可省略分号的遗留引用（HTML4 集合）。 */
const LEGACY_REFS = new Set([...LATIN1_REF_NAMES, 'lt', 'gt', 'amp', 'quot', 'LT', 'GT', 'AMP', 'QUOT']);

/** 数字引用落在 C1 控制区（0x80–0x9F）时的浏览器映射表（未列出的码位保持原值）。 */
const C1_REPLACEMENTS = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);

function decodeNumericRef(cp) {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  if (C1_REPLACEMENTS.has(cp)) return String.fromCodePoint(C1_REPLACEMENTS.get(cp));
  return String.fromCodePoint(cp);
}

/**
 * 按浏览器规则解码字符引用（&#32; / &#x20; / &amp; 等）。
 * inAttribute 为 true 时应用属性中的历史规则：无分号的遗留引用若紧跟 "=" 或字母数字，
 * 则不解码（避免破坏 URL 等场景）。未知引用保持原样（与浏览器一致）。
 */
export function decodeCharRefs(text, { inAttribute = false } = {}) {
  if (typeof text !== 'string' || !text.includes('&')) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const amp = text.indexOf('&', i);
    if (amp === -1) { out += text.slice(i); break; }
    out += text.slice(i, amp);
    i = amp + 1;
    const rest = text.slice(i);

    // 数字引用：分号可省略（浏览器容错），无数字则原样保留
    let m = /^#(?:[xX]([0-9A-Fa-f]+)|([0-9]+));?/.exec(rest);
    if (m) {
      out += decodeNumericRef(parseInt(m[1] ?? m[2], m[1] ? 16 : 10));
      i += m[0].length;
      continue;
    }

    // 命名引用
    m = /^([0-9A-Za-z]+)(;?)/.exec(rest);
    if (m) {
      const [raw, name, semi] = m;
      if (semi && NAMED_REFS.has(name)) {
        out += NAMED_REFS.get(name);
        i += raw.length;
        continue;
      }
      // 无分号（或名称未收录）：取名称前缀中最长的遗留引用
      let legacy = null;
      for (let len = name.length; len > 1 && !legacy; len--) {
        const prefix = name.slice(0, len);
        if (LEGACY_REFS.has(prefix)) legacy = prefix;
      }
      if (legacy) {
        const next = text[i + legacy.length];
        const literalInAttr = inAttribute && next !== undefined && (next === '=' || /[0-9A-Za-z]/.test(next));
        if (!literalInAttr) {
          out += NAMED_REFS.get(legacy);
          i += legacy.length;
          continue;
        }
      }
    }

    out += '&'; // 无法识别的引用：原样保留
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* HTML 解析                                                           */
/* ------------------------------------------------------------------ */

/**
 * 解析受限 HTML，返回 { roots, errors }。
 * 节点结构：{ tag, id, classes, children, parent, path }
 * path 为从根开始的元素下标序列，如 "0.2.1"（文本节点不计入下标）。
 *
 * 树构造与浏览器（innerHTML，in-body 插入模式）保持一致，使预览、
 * /api/compute 与 /api/analyze 使用同一棵元素树与同一套路径：
 *  - div / section / p 开始标签会隐式闭合处于打开状态的 p；
 *  - 结束标签找不到匹配元素时：div / section / span 被忽略，</p> 会生成一个空 p 元素；
 *  - 结束标签与栈顶不匹配时按浏览器规则弹栈恢复（如 <div><p>x</div> 中 p 被隐式闭合）；
 *  - </span> 仅当栈顶为 span 时生效（div / section / p 属于 special 类别，会挡住查找）；
 *  - EOF 时未闭合的标签自动闭合，不报错。
 * 超出 div / section / p / span、id / class 范围的内容（未知标签、未知属性、
 * 自闭合写法、属性语法错误等）依旧报错。
 */
export function parseHtml(source) {
  const errors = [];
  const roots = [];
  const stack = [];
  const pushError = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); };

  if (typeof source !== 'string') {
    return { roots, errors: ['HTML 内容必须是字符串'] };
  }
  // 浏览器会在输入流层面把 \r\n 与 \r 规范化为 \n
  const input = source.replace(/\r\n?/g, '\n');

  // —— 与浏览器一致的栈操作（本标签子集中没有作用域边界元素，
  //    因此"p 是否在 button scope 中"等价于栈上是否存在 p）——
  const hasOpen = (tag) => stack.some((n) => n.tag === tag);
  /** "close a p element"：弹出直到最近一个 p 被弹出（本标签集合下无需先生成隐含结束标签）。 */
  const closeP = () => {
    while (stack.length) {
      if (stack.pop().tag === 'p') break;
    }
  };
  /** 生成隐含结束标签：本标签集合中仅 p 会被隐式闭合。 */
  const generateImpliedEndTags = () => {
    while (stack.length && stack[stack.length - 1].tag === 'p') stack.pop();
  };
  const makeNode = (tag) => ({ tag, id: null, classes: [], children: [], parent: null, path: '' });
  const insert = (node) => {
    const parent = stack[stack.length - 1] || null;
    node.parent = parent;
    if (parent) parent.children.push(node); else roots.push(node);
  };

  // 标签匹配需容忍引号内的 ">"（如 class="a>b"）
  const tokenRe = /<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g;
  let m;
  let pos = 0;
  while ((m = tokenRe.exec(input)) !== null) {
    if (m.index !== pos) {
      pushError(`无法解析的内容：${JSON.stringify(input.slice(pos, m.index))}（文本中不允许出现孤立的 "<"）`);
    }
    pos = m.index + m[0].length;
    const token = m[0];
    if (token[0] !== '<') continue; // 文本节点：层叠判定无需保存

    if (token.startsWith('</')) {
      const cm = /^<\/\s*([A-Za-z][A-Za-z0-9-]*)\s*>$/.exec(token);
      if (!cm) { pushError(`无法解析的结束标签：${token}`); continue; }
      const name = cm[1].toLowerCase();
      if (!ALLOWED_TAGS.includes(name)) {
        pushError(`不支持的标签 </${name}>（仅允许 ${ALLOWED_TAGS.join(' / ')}）`);
        continue;
      }
      if (name === 'p') {
        if (hasOpen('p')) {
          closeP();
        } else {
          // 浏览器对孤立的 </p> 会插入一个空 p 元素再立即闭合
          insert(makeNode('p'));
        }
      } else if (name === 'span') {
        // "any other end tag"：自栈顶向上查找 span，但 div/section/p 属于
        // special 类别会立即终止查找；本标签集合下即"仅栈顶为 span 时才闭合"。
        if (stack.length && stack[stack.length - 1].tag === 'span') stack.pop();
      } else {
        // div / section：无匹配元素则忽略；否则隐式闭合 p 后弹栈至目标元素
        if (!hasOpen(name)) continue;
        generateImpliedEndTags();
        while (stack.length) {
          if (stack.pop().tag === name) break;
        }
      }
      continue;
    }

    const om = /^<([A-Za-z][A-Za-z0-9-]*)([\s\S]*?)(\/?)>$/.exec(token);
    if (!om) { pushError(`无法解析的标签：${token}`); continue; }
    const tag = om[1].toLowerCase();
    const attrSrc = om[2];
    const selfClose = om[3] === '/';

    if (!ALLOWED_TAGS.includes(tag)) {
      pushError(`不支持的标签 <${tag}>（仅允许 ${ALLOWED_TAGS.join(' / ')}）`);
      continue;
    }
    if (selfClose) {
      // 浏览器 innerHTML 会忽略非 void 标签的自闭合斜杠，为避免预览与判定不一致，直接报错
      pushError(`<${tag}> 不允许自闭合写法，请显式书写 </${tag}>`);
      continue;
    }

    const { attrs, error: attrError } = parseAttributes(attrSrc);
    if (attrError) { pushError(`<${tag}> 的属性语法错误：${attrError}`); continue; }

    const node = makeNode(tag);
    let bad = false;
    for (const { name, value: rawValue } of attrs) {
      // 与浏览器一致：属性值中的字符引用先解码再使用
      const value = decodeCharRefs(rawValue, { inAttribute: true });
      if (name === 'id') {
        if (node.id !== null) { pushError(`<${tag}> 上 id 属性重复`); bad = true; break; }
        if (!value) { pushError(`<${tag}> 的 id 不能为空`); bad = true; break; }
        node.id = value;
      } else if (name === 'class') {
        if (node._seenClass) { pushError(`<${tag}> 上 class 属性重复`); bad = true; break; }
        node._seenClass = true;
        // 浏览器 classList 仅按 ASCII 空白拆分（&nbsp; 解码出的 U+00A0 不算分隔符）
        node.classes = value.split(/[\t\n\f\r ]+/).filter(Boolean);
      } else {
        pushError(`<${tag}> 不支持属性 "${name}"（仅允许 id / class）`);
        bad = true;
        break;
      }
    }
    if (bad) continue;
    delete node._seenClass;

    // 块级开始标签（div / section / p）会隐式闭合处于打开状态的 p；span 不会
    if (tag !== 'span' && hasOpen('p')) closeP();
    insert(node);
    stack.push(node);
  }
  if (pos < input.length) {
    pushError(`无法解析的内容：${JSON.stringify(input.slice(pos))}（文本中不允许出现孤立的 "<"）`);
  }
  // EOF：浏览器会自动闭合未闭合的标签，此处同样不报错（栈中节点已挂入树中）

  // 赋路径
  const assign = (node, path) => {
    node.path = path;
    node.children.forEach((c, i) => assign(c, `${path}.${i}`));
  };
  roots.forEach((n, i) => assign(n, String(i)));

  return { roots, errors };
}

function parseAttributes(src) {
  const attrs = [];
  const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let last = 0;
  let m;
  while ((m = attrRe.exec(src)) !== null) {
    if (src.slice(last, m.index).trim() !== '') {
      return { attrs, error: `无法解析的片段 "${src.slice(last, m.index).trim()}"` };
    }
    last = m.index + m[0].length;
    attrs.push({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? '' });
  }
  if (src.slice(last).trim() !== '') {
    return { attrs, error: `无法解析的片段 "${src.slice(last).trim()}"` };
  }
  return { attrs, error: null };
}

/** 按路径（如 "0.2.1"）查找元素节点。 */
export function findByPath(roots, path) {
  if (typeof path !== 'string' || !/^\d+(\.\d+)*$/.test(path)) return null;
  let nodes = roots;
  let node = null;
  for (const part of path.split('.')) {
    node = nodes[Number(part)];
    if (!node) return null;
    nodes = node.children;
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* 选择器解析与匹配                                                     */
/* ------------------------------------------------------------------ */

/**
 * 解析选择器，非法语法抛出 Error（中文消息）。
 * 返回 { source, parts, specificity }：
 *  - parts[i] = { combinator: null | 'descendant' | 'child', compound }
 *    combinator 表示该复合选择器与其左侧部分之间的连接方式；
 *  - compound = { type, ids: [], classes: [] }
 *  - specificity = [ID 数, 类数, 类型数]
 */
export function parseSelector(source) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error('选择器不能为空');
  }
  const s = source.trim();
  const tokens = [];
  let buf = '';
  const pushCompound = () => {
    if (buf) { tokens.push({ t: 'c', v: buf }); buf = ''; }
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '>') {
      pushCompound();
      const last = tokens[tokens.length - 1];
      if (last && last.t === 'd') tokens.pop(); // "a > b"：空白不产生后代组合器
      const prev = tokens[tokens.length - 1];
      if (!prev || prev.t !== 'c') throw new Error(`选择器语法错误：">" 左侧缺少选择器（"${s}"）`);
      tokens.push({ t: '>' });
    } else if (/\s/.test(ch)) {
      pushCompound();
      const last = tokens[tokens.length - 1];
      if (last && last.t === 'c') tokens.push({ t: 'd' });
    } else {
      buf += ch;
    }
  }
  pushCompound();

  if (!tokens.length || tokens[0].t !== 'c' || tokens[tokens.length - 1].t !== 'c') {
    throw new Error(`选择器语法错误：组合器位置不正确（"${s}"）`);
  }
  for (let i = 1; i < tokens.length; i += 2) {
    if (tokens[i].t === 'c') throw new Error(`选择器语法错误：复合选择器之间缺少组合器（"${s}"）`);
  }

  const parts = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const combinator = i === 0 ? null : (tokens[i - 1].t === '>' ? 'child' : 'descendant');
    parts.push({ combinator, compound: parseCompound(tokens[i].v) });
  }

  const specificity = [0, 0, 0];
  for (const p of parts) {
    specificity[0] += p.compound.ids.length;
    specificity[1] += p.compound.classes.length;
    specificity[2] += p.compound.type ? 1 : 0;
  }
  return { source: s, parts, specificity };
}

function parseCompound(str) {
  const compound = { type: null, ids: [], classes: [] };
  const re = /([#.]?)([A-Za-z0-9_-]+)/y;
  let pos = 0;
  while (pos < str.length) {
    re.lastIndex = pos;
    const m = re.exec(str);
    if (!m) throw new Error(`选择器语法错误：无法解析 "${str}"（不支持的字符或写法）`);
    const [, prefix, name] = m;
    if (prefix === '#') {
      if (!IDENT_RE.test(name)) throw new Error(`ID 选择器名称非法："#${name}"`);
      compound.ids.push(name);
    } else if (prefix === '.') {
      if (!IDENT_RE.test(name)) throw new Error(`类选择器名称非法：".${name}"`);
      compound.classes.push(name);
    } else {
      if (compound.type || compound.ids.length || compound.classes.length) {
        throw new Error(`类型选择器必须位于复合选择器开头："${str}"`);
      }
      const tag = name.toLowerCase();
      if (!ALLOWED_TAGS.includes(tag)) {
        throw new Error(`不支持的类型选择器 "${name}"（仅支持 ${ALLOWED_TAGS.join(' / ')}）`);
      }
      compound.type = tag;
    }
    pos += m[0].length;
  }
  return compound;
}

function matchCompound(node, compound) {
  if (compound.type && node.tag !== compound.type) return false;
  if (compound.ids.length && !compound.ids.every((id) => node.id === id)) return false;
  if (compound.classes.length && !compound.classes.every((c) => node.classes.includes(c))) return false;
  return true;
}

/** 判断选择器是否匹配元素节点（沿父链匹配祖先）。 */
export function matchesSelector(node, selector) {
  const parts = selector.parts;
  const matchFrom = (el, idx) => {
    if (!el || !matchCompound(el, parts[idx].compound)) return false;
    if (idx === 0) return true;
    if (parts[idx].combinator === 'child') return matchFrom(el.parent, idx - 1);
    let p = el.parent;
    while (p) {
      if (matchFrom(p, idx - 1)) return true;
      p = p.parent;
    }
    return false;
  };
  return matchFrom(node, parts.length - 1);
}

/* ------------------------------------------------------------------ */
/* 规则编译                                                             */
/* ------------------------------------------------------------------ */

/**
 * 校验并编译规则列表。
 * 返回 { compiled, errors, layerOrder }：
 *  - compiled：合法声明，含 { index, selector, property, value, layer, important, parsed, specificity, order, layerIdx }
 *  - errors：[{ index, messages: [] }]
 *  - layerOrder：层名按首次出现排列
 */
export function compileRules(rules) {
  const compiled = [];
  const errors = [];
  const layerOrder = [];
  const layerIdxOf = new Map();
  const list = Array.isArray(rules) ? rules : [];

  list.forEach((rule, index) => {
    const messages = [];
    const selectorSrc = typeof rule?.selector === 'string' ? rule.selector.trim() : '';
    let parsed = null;
    if (!selectorSrc) {
      messages.push('选择器不能为空');
    } else {
      try { parsed = parseSelector(selectorSrc); } catch (e) { messages.push(e.message); }
    }

    const property = rule?.property;
    if (!ALLOWED_PROPS.includes(property)) {
      messages.push(`属性必须是 ${ALLOWED_PROPS.join(' / ')} 之一`);
    }

    const value = typeof rule?.value === 'string' ? rule.value.trim() : '';
    if (!value) messages.push('样式值不能为空');

    let layer = null;
    if (rule?.layer != null && String(rule.layer).trim() !== '') {
      layer = String(rule.layer).trim();
      if (!IDENT_RE.test(layer)) {
        messages.push(`层名非法："${layer}"（仅允许字母、数字、"-"、"_"，且不以数字开头）`);
      }
    }

    if (messages.length) {
      errors.push({ index, messages });
      return;
    }

    if (layer && !layerIdxOf.has(layer)) {
      layerIdxOf.set(layer, layerOrder.length);
      layerOrder.push(layer);
    }
    compiled.push({
      index,
      selector: selectorSrc,
      property,
      value,
      layer,
      important: !!rule?.important,
      parsed,
      specificity: parsed.specificity,
      order: index,
      layerIdx: layer ? layerIdxOf.get(layer) : -1,
    });
  });

  return { compiled, errors, layerOrder };
}

/* ------------------------------------------------------------------ */
/* 层叠判定                                                             */
/* ------------------------------------------------------------------ */

/**
 * 比较两条声明的优先级。返回 1 表示 a 胜出，-1 表示 b 胜出，0 表示完全并列。
 */
function compareDecl(a, b) {
  if (a.important !== b.important) return a.important ? 1 : -1;

  if (a.layerIdx !== b.layerIdx || (a.layer === null) !== (b.layer === null)) {
    // 层排名：无层记为 Infinity。
    // 普通声明：排名大者胜（无层 > 有层；有层时后层优先）。
    // !important：排名小者胜（有层 > 无层；有层时先层优先）。
    const ra = a.layer === null ? Infinity : a.layerIdx;
    const rb = b.layer === null ? Infinity : b.layerIdx;
    if (ra !== rb) {
      const aWins = a.important ? ra < rb : ra > rb;
      return aWins ? 1 : -1;
    }
  }

  for (let k = 0; k < 3; k++) {
    if (a.specificity[k] !== b.specificity[k]) return a.specificity[k] > b.specificity[k] ? 1 : -1;
  }
  if (a.order !== b.order) return a.order > b.order ? 1 : -1;
  return 0;
}

const SPEC_NAMES = ['ID', '类', '类型'];

/** 生成 loser 相对 winner 的落败原因。 */
function describeLoss(loser, winner) {
  if (loser.important !== winner.important) {
    return '胜出声明带有 !important，优先于所有普通声明';
  }
  if (loser.important) {
    if (loser.layer === null && winner.layer !== null) {
      return `!important 声明中，有层声明优先于无层声明（胜出者位于层「${winner.layer}」）`;
    }
    if (loser.layer !== null && winner.layer === null) {
      return '!important 声明中，无层声明低于有层声明';
    }
    if (loser.layerIdx !== winner.layerIdx) {
      return `!important 声明中，先出现的层优先：层「${winner.layer}」先于层「${loser.layer}」`;
    }
  } else {
    if (loser.layer !== null && winner.layer === null) {
      return `普通声明中，无层声明优先于有层声明（本声明位于层「${loser.layer}」）`;
    }
    if (loser.layer === null && winner.layer !== null) {
      return '普通声明中，有层声明低于无层声明';
    }
    if (loser.layerIdx !== winner.layerIdx) {
      return `普通声明中，后出现的层优先：层「${winner.layer}」晚于层「${loser.layer}」`;
    }
  }
  for (let k = 0; k < 3; k++) {
    if (loser.specificity[k] !== winner.specificity[k]) {
      return `特异性比较：${SPEC_NAMES[k]}选择器数量 ${winner.specificity[k]} > ${loser.specificity[k]}`
        + `（胜出者 (${winner.specificity.join(', ')})，本声明 (${loser.specificity.join(', ')})）`;
    }
  }
  return `特异性相同，规则顺序靠后者优先（第 ${winner.order + 1} 条规则晚于第 ${loser.order + 1} 条）`;
}

/**
 * 分析某元素某属性的全部匹配声明，按优先级从高到低返回。
 * 每项：{ ruleIndex, selector, property, value, layer, important, specificity, winner, reason }
 */
export function analyzeElement(node, property, compiled) {
  const decls = compiled.filter((d) => d.property === property && matchesSelector(node, d.parsed));
  decls.sort((a, b) => -compareDecl(a, b));
  const winner = decls[0] || null;
  return decls.map((d, i) => ({
    ruleIndex: d.index,
    selector: d.selector,
    property: d.property,
    value: d.value,
    layer: d.layer,
    important: d.important,
    specificity: [...d.specificity],
    winner: i === 0,
    reason: i === 0 ? null : describeLoss(d, winner),
  }));
}

/** 计算所有元素在三个属性上的胜出值，返回 { path: { property: value } }。 */
export function computeAllStyles(roots, compiled) {
  const styles = {};
  const walk = (node) => {
    const props = {};
    for (const prop of ALLOWED_PROPS) {
      const result = analyzeElement(node, prop, compiled);
      if (result.length) props[prop] = result[0].value;
    }
    if (Object.keys(props).length) styles[node.path] = props;
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return styles;
}

/* ------------------------------------------------------------------ */
/* 等价精简                                                             */
/* ------------------------------------------------------------------ */

/** 等价精简允许的最大元素数与最大合法规则数。 */
export const SIMPLIFY_MAX_ELEMENTS = 40;
export const SIMPLIFY_MAX_RULES = 10;

/** 统计元素树中的元素总数。 */
export function countElements(roots) {
  let count = 0;
  const walk = (node) => {
    count++;
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return count;
}

/**
 * 计算全树每个元素在三个属性上的"胜出值签名"：
 * Map<"path property", value | null>，null 表示无任何匹配声明。
 * 把"无声明"也纳入签名，保证精简后连缺失状态都必须一致。
 */
function cascadeSignature(roots, compiled) {
  const sig = new Map();
  const walk = (node) => {
    for (const prop of ALLOWED_PROPS) {
      const matched = analyzeElement(node, prop, compiled);
      sig.set(`${node.path} ${prop}`, matched.length ? matched[0].value : null);
    }
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return sig;
}

function sameSignature(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

/** 原序号序列的字典序比较（长度相同时使用）。 */
function lexicallyLess(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

/**
 * 等价精简：在全部合法的规则序列中，找出保留条数最少的原序子序列，
 * 使全树每个元素的 color / background-color / font-size 胜出值
 * （包括无任何匹配声明的状态）与原规则集完全相同；
 * 若有多个最优解，取保留原序号序列字典序最小的一个。
 *
 * 每个候选都按剩余规则重新 compileRules —— 层名首次出现顺序随剩余规则
 * 重排（层只是从顺序表中删除，存活层相对次序不变，但层集合本身变化），
 * 绝不复用原编译结果，也不按"某条规则是否曾胜出于某处"做局部删除。
 *
 * 调用方须先保证 HTML 无解析错误、规则全部合法且数量 ≤ SIMPLIFY_MAX_RULES。
 *
 * 返回 { kept, removed, layerOrder, originalLayerOrder }：
 *  - kept / removed：保留 / 删除的原规则下标（0 基），kept 按下标升序；
 *  - layerOrder：精简后按保留规则首次出现重算的层顺序；
 *  - originalLayerOrder：原规则集的层顺序。
 */
export function simplifyRules(roots, rules) {
  const list = Array.isArray(rules) ? rules : [];
  const n = list.length;

  const full = compileRules(list);
  const target = cascadeSignature(roots, full.compiled);

  let best = null;
  let bestLayerOrder = full.layerOrder;

  // 穷举全部 2^n 个原序子序列（含空集）。n ≤ 10，候选至多 1024 个。
  for (let mask = 0; mask < (1 << n); mask++) {
    const kept = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) kept.push(i);
    }
    if (best !== null && kept.length > best.length) continue;

    // 关键：按剩余规则重新编译，层名首次出现顺序与规则先后均重新计算
    const candidate = compileRules(kept.map((i) => list[i]));
    if (!sameSignature(cascadeSignature(roots, candidate.compiled), target)) continue;

    if (best === null || kept.length < best.length
      || (kept.length === best.length && lexicallyLess(kept, best))) {
      best = kept;
      bestLayerOrder = candidate.layerOrder;
    }
  }

  // 全量候选必然与目标签名相同，因此 n ≥ 0 时 best 一定非 null
  const keptSet = new Set(best);
  const removed = [];
  for (let i = 0; i < n; i++) {
    if (!keptSet.has(i)) removed.push(i);
  }
  return {
    kept: best,
    removed,
    layerOrder: bestLayerOrder,
    originalLayerOrder: full.layerOrder,
  };
}

/* ------------------------------------------------------------------ */
/* 唯一选择器                                                           */
/* ------------------------------------------------------------------ */

/** 唯一选择器允许的最大元素数、向上追溯的祖先层数与最大段数。 */
export const LOCATOR_MAX_ELEMENTS = 40;
export const LOCATOR_MAX_ANCESTORS = 7;
export const LOCATOR_MAX_SEGMENTS = 3;

/**
 * 节点可提供的段字符串：类型、合法 #id、单个合法 .class。
 * 只保留能写进合法选择器的标识符（与 parseSelector 相同的 IDENT_RE 规则），
 * id / class 中含有其他字符（空白、数字开头等）时该值不能作为段。
 * 同一节点上匹配集完全相同的段，在任何选择器中的命中效果都一致，
 * 故只保留（字符串长度最短、字典序最小的）代表，不会因此丢失最优解。
 */
function segmentStrings(node, elements) {
  const raw = [node.tag];
  if (node.id && IDENT_RE.test(node.id)) raw.push(`#${node.id}`);
  const seenClasses = new Set();
  for (const c of node.classes) {
    if (!IDENT_RE.test(c) || seenClasses.has(c)) continue;
    seenClasses.add(c);
    raw.push(`.${c}`);
  }
  const bestByMatch = new Map(); // 匹配集签名 -> 最优段字符串
  for (const seg of raw) {
    const parsed = parseSelector(seg);
    let key = '';
    for (const el of elements) key += matchesSelector(el, parsed) ? '1' : '0';
    const cur = bestByMatch.get(key);
    if (!cur || seg.length < cur.length || (seg.length === cur.length && seg < cur)) {
      bestByMatch.set(key, seg);
    }
  }
  return [...bestByMatch.values()];
}

/** 候选排序：字符串长度最短者优先，并列时字典序最小者优先。 */
function byLengthThenLex(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * 为目标元素生成"唯一选择器"：在整棵元素树中只命中目标。
 *
 * 候选构造（与预览、/api/compute 使用同一棵元素树）：
 *  - 段取自目标及最近 LOCATOR_MAX_ANCESTORS 层祖先的类型、合法 #id、单个合法 .class；
 *  - 必须含目标段（最右段），至多 LOCATOR_MAX_SEGMENTS 段；
 *  - 段间用后代空格或直接子代 > 连接（结果中 > 两侧不加空格，使长度与字典序比较确定）。
 *
 * ">" 仅在两段对应节点为父子（链上相邻层）时才生成：若某段字符串能匹配目标的
 * 父元素，该字符串必然也在父节点的段列表中（type / 合法 #id / 合法 .class 的
 * 定义对匹配它的节点自洽），会由相邻层位置生成同一候选，故跨层 ">" 候选不可能
 * 命中目标，无需生成。
 *
 * 每个候选都用 parseSelector + matchesSelector（与规则判定完全相同的匹配规则）
 * 在整棵树上验证只命中目标；按段数最少、字符串长度最短、字典序最小返回。
 *
 * 返回 { selector, segments }；无候选时返回 { selector: null, segments: 0 }。
 */
export function uniqueLocator(roots, target) {
  const elements = [];
  const collect = (n) => { elements.push(n); n.children.forEach(collect); };
  roots.forEach(collect);

  // 目标及最近 LOCATOR_MAX_ANCESTORS 层祖先（chain[0] 为目标）
  const chain = [];
  for (let n = target; n && chain.length <= LOCATOR_MAX_ANCESTORS; n = n.parent) {
    chain.push(n);
  }
  const segPool = chain.map((n) => segmentStrings(n, elements));
  const targetSegs = segPool[0];

  // 用现有选择器匹配规则验证：候选在整棵树上只命中目标
  const isUnique = (source) => {
    let parsed;
    try { parsed = parseSelector(source); } catch { return false; }
    let hitTarget = false;
    for (const el of elements) {
      if (!matchesSelector(el, parsed)) continue;
      if (el === target) hitTarget = true;
      else return false; // 命中了其他元素
    }
    return hitTarget;
  };

  // 1 段：目标段本身
  {
    const one = targetSegs.filter(isUnique).sort(byLengthThenLex);
    if (one.length) return { selector: one[0], segments: 1 };
  }

  // 2 段：祖先段 + 目标段
  {
    const two = new Set();
    for (let i = 1; i < chain.length; i++) {
      const conns = i === 1 ? [' ', '>'] : [' '];
      for (const b of segPool[i]) {
        for (const t of targetSegs) {
          for (const c of conns) two.add(b + c + t);
        }
      }
    }
    for (const sel of [...two].sort(byLengthThenLex)) {
      if (isUnique(sel)) return { selector: sel, segments: 2 };
    }
  }

  // 3 段：两个祖先段（远 → 近）+ 目标段
  {
    const three = new Set();
    for (let j = 1; j < chain.length; j++) {
      const c2s = j === 1 ? [' ', '>'] : [' '];
      for (let i = j + 1; i < chain.length; i++) {
        const c1s = i - j === 1 ? [' ', '>'] : [' '];
        for (const a of segPool[i]) {
          for (const b of segPool[j]) {
            for (const t of targetSegs) {
              for (const c1 of c1s) {
                for (const c2 of c2s) three.add(a + c1 + b + c2 + t);
              }
            }
          }
        }
      }
    }
    for (const sel of [...three].sort(byLengthThenLex)) {
      if (isUnique(sel)) return { selector: sel, segments: 3 };
    }
  }

  return { selector: null, segments: 0 };
}
