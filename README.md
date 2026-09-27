# CSS 层叠判定工作台

本地运行的 CSS 层叠（Cascade）判定学习与调试工具：编辑受限 HTML，添加带选择器 / 属性值 / 层名 / `!important` 标记的规则，点击预览中的元素并选择属性，即可查看**全部匹配声明、胜出值以及每条落败声明的具体落败原因**；可为选中元素生成在全树只命中它的**唯一选择器**并一键复制；还可使用「等价精简」找出与原规则集层叠结果完全等价的最短原序规则子序列。

- 后端：Node.js 原生 `http`，**零第三方依赖**
- 前端：原生 HTML / CSS / JavaScript（预览使用 Shadow DOM 隔离）
- 仅判定 `color` / `background-color` / `font-size` 三个属性
- 不计继承、不计浏览器默认样式

## 快速开始

### Docker Compose（推荐）

```bash
docker compose up --build
```

启动后访问 <http://localhost:3000> 。

停止：`Ctrl+C`，或在另一终端执行 `docker compose down`。

### 本地直接运行

需要 Node.js ≥ 18：

```bash
npm start
# 或 node server.js
```

## 使用说明

### 1. 编辑 HTML

只允许以下内容，任何越界内容都会在编辑器下方报错：

- 标签：`div`、`section`、`p`、`span`
- 属性：`id`、`class`
- 文本内容

解析行为与浏览器（预览）严格一致，保证预览、`/api/compute`、`/api/analyze` 使用同一棵元素树与同一套路径：

- 属性值中的字符引用（`&#32;`、`&#x20;`、`&amp;` 等）按浏览器规则解码，例如 `class="foo&#32;bar"` 会得到 `foo` 与 `bar` 两个类；
- 浏览器会隐式闭合的写法按浏览器规则建树，例如 `<p>a<div>b</div></p>` 中 `div` 是 `p` 的兄弟（末尾孤立的 `</p>` 还会生成一个空 `p`）；未闭合的标签在末尾自动闭合；
- 未知标签、未知属性（含 `onclick` 等事件属性与 `<script>`）、自闭合写法等越界内容依旧报错，且不会进入预览。

### 2. 添加规则

每条规则包含：

| 字段 | 说明 |
| --- | --- |
| 选择器 | 类型 `div`、ID `#id`、类 `.class`、后代组合 `div p`、直接子代组合 `section > p`，可复合如 `#main .box > span`；非法语法会在行内报错 |
| 属性 | `color` / `background-color` / `font-size` |
| 值 | 任意非空字符串（如 `red`、`#f00`、`16px`） |
| 层名 | 可空。仅允许字母、数字、`-`、`_`，且不以数字开头 |
| `!important` | 勾选后为重要声明 |

### 3. 点击预览元素并选择属性

- 鼠标悬停高亮，点击元素即选中（橙色轮廓）。
- 选择 `color` / `background-color` / `font-size`，右侧按优先级从高到低列出匹配声明：
  - 绿色卡片为**胜出声明**及其胜出值；
  - 其余卡片给出**落败原因**，例如 `!important` 压制、无层/有层差异、层先后、特异性中 ID/类/类型数量差异、规则顺序靠后等。
- 预览会把各元素的胜出值应用到画面上；无胜出声明的属性使用中性占位值，**不模拟继承与默认样式**。

顶部下拉框可一键载入 3 个内置示例。

### 4. 唯一选择器

点击预览元素后，「当前元素」下方会显示该元素的**唯一选择器**——在整棵元素树中只命中该元素的最优选择器，点击「复制」即可拷入剪贴板：

- 段取自**目标及最近 7 层祖先**，每段从该节点的**类型、合法 `#id`、单个合法 `.class`** 中选一个（id / class 必须能构成合法选择器标识符，否则不作为段）；**必须含目标段，最多 3 段**，段间用后代空格或直接子代 `>` 连接。
- 每个候选都用与规则判定**完全相同的选择器匹配规则**在整棵树上验证只命中目标，按**段数最少、字符串长度最短、字典序最小**返回（结果中 `>` 两侧不加空格，使长度与字典序比较确定）。
- 仅接受合法 HTML 中**至多 40 个元素**；HTML 非法、路径失效、超过规模上限或不存在满足条件的候选时会说明原因，且**不改动 HTML 与规则**。

### 5. 等价精简

点击规则区右上角的「✂ 等价精简」，在**不改变任何元素 `color` / `background-color` / `font-size` 胜出值（包括"无任何匹配声明"的状态）**的前提下，从原规则集中找出**保留条数最少的原序子序列**：

- 适用规模：合法 HTML 中**至多 40 个元素**、**至多 10 条合法规则**；HTML 或规则报错、超过规模上限时会说明原因，且**不改动输入**。
- 算法穷举全部 2^n 个原序子序列（n ≤ 10，最多 1024 个候选），**每个候选都按剩余规则重新编译**：层名首次出现顺序按保留规则重排，再重新计算全树层叠结果，绝不复用原编译结果，也不是简单删除"从未胜出"的规则（删除规则可能改变层集合与顶替关系）。
- 若存在多个保留条数相同的最优解，取**保留原序号序列字典序最小**的一个。
- 结果以弹窗展示：保留、删除的**原规则序号**（#n 从 1 开始），原层顺序与按保留规则重算的**新层顺序**，以及每条规则的去留明细。
- 只有点击「确认替换」后才会用保留规则替换编辑区；点「取消」/ 遮罩 / 按 Esc 均不改动。

## 层叠判定规则（本工具实现）

1. `!important` 声明优先于普通声明。
2. 普通声明：**无层 > 有层**；同有层时，**后出现的层优先**。
3. `!important` 声明：**有层 > 无层**；同有层时，**先出现的层优先**（与普通声明相反）。
4. 层顺序按层名在规则列表中**首次出现**的位置确定（`@layer` 声明顺序的简化模型）。
5. 同层且同重要级：依次比较
   1. ID 选择器数量（多者胜）；
   2. 类选择器数量；
   3. 类型选择器数量；
   4. 规则顺序（靠后者胜）。
6. 不参与继承链，不考虑浏览器默认样式。

### 内置示例

| 示例 | 演示内容 |
| --- | --- |
| 层顺序演示 | 无层普通声明胜过有层；普通声明后层（components）胜先层（base） |
| 特异性演示 | `#id` > `.class` > 类型；类型数量也参与比较 |
| !important 与层 | important 压制普通声明；有层 important 胜无层 important；先层 important 胜后层（即使特异性更低） |

## HTTP API

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/compute` | POST | 入参 `{ html, rules }`；返回校验错误、层顺序与全树胜出值（供预览渲染） |
| `/api/analyze` | POST | 入参 `{ html, rules, path, property }`；返回该元素该属性的匹配声明（按优先级排序，含落败原因） |
| `/api/simplify` | POST | 入参 `{ html, rules }`；返回与原规则集三属性胜出值完全等价的最短原序规则子序列（仅接受合法 HTML ≤40 元素、合法规则 ≤10 条） |
| `/api/locator` | POST | 入参 `{ html, path }`；返回在整棵元素树中只命中该元素的唯一选择器（仅接受合法 HTML ≤40 元素） |
| `/api/examples` | GET | 返回内置示例列表 |

`path` 为元素下标路径（根元素 `0`，其第二个子元素 `0.1`，以此类推）。

```bash
curl -s -X POST http://localhost:3000/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"html":"<div><p class=\"a\">x</p></div>","rules":[{"selector":"p","property":"color","value":"red","layer":"","important":false}],"path":"0.0","property":"color"}'
```

`/api/simplify` 成功时返回 `ok: true` 与 `kept` / `removed`（保留 / 删除的原规则下标，0 基，按下标升序）、`layerOrder`（按保留规则重算的新层顺序）、`originalLayerOrder`、`elementCount`、`ruleCount`；HTML / 规则非法或超过 40 元素 / 10 规则上限时返回 `ok: false` 与中文 `message`（附带 `htmlErrors` / `ruleErrors`），不修改任何输入：

```bash
curl -s -X POST http://localhost:3000/api/simplify \
  -H 'Content-Type: application/json' \
  -d '{"html":"<p class=\"a\">x</p>","rules":[{"selector":"span","property":"color","value":"red","layer":"b","important":false},{"selector":".a","property":"color","value":"red","layer":"a","important":false}]}'
# {"ok":true,...,"kept":[1],"removed":[0],"layerOrder":["a"],"originalLayerOrder":["b","a"],...}
```

`/api/locator` 成功时返回 `ok: true` 与 `selector`（唯一选择器字符串）、`segments`（段数）、`path`、`elementCount`；HTML 非法、路径失效、超过 40 元素上限或无候选时返回 `ok: false` 与中文 `message`（HTML 非法时附带 `htmlErrors`），不修改任何输入：

```bash
curl -s -X POST http://localhost:3000/api/locator \
  -H 'Content-Type: application/json' \
  -d '{"html":"<div id=\"main\"><p class=\"text\">a</p><p>b</p></div>","path":"0.0"}'
# {"ok":true,"htmlErrors":[],"elementCount":3,"path":"0.0","selector":".text","segments":1}
```

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server.js            # Node 原生 HTTP 服务：静态资源 + API
├── src/
│   └── engine.js        # 层叠引擎：HTML/选择器解析、匹配、层叠判定
├── public/
│   ├── index.html       # 单页界面
│   ├── styles.css
│   └── app.js           # 原生前端逻辑（Shadow DOM 预览）
├── examples/            # 内置示例（JSON，可自行增删）
│   ├── 01-layer-order.json
│   ├── 02-specificity.json
│   └── 03-important.json
└── test/
    └── engine.test.js   # 零依赖引擎测试：npm test
```

## 开发与测试

```bash
npm test          # 运行层叠引擎的全部判定用例
PORT=8080 npm start
```

## 边界说明

- 不支持伪类、伪元素、属性选择器、通用选择器 `*`、兄弟组合器、逗号分组等；输入即报错。
- 不解析 `<style>`、注释、DOCTYPE；HTML 中只允许规定的 4 个标签与 2 个属性。
- 命名字符引用覆盖常用子集（Latin-1 全集与 `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&nbsp;` 等）；数字引用（十进制 / 十六进制）完整支持。未收录的引用名与浏览器对未知引用的处理一致：原样保留。
- `em` 等相对单位在浏览器预览中的渲染遵循浏览器自身规则；判定面板以声明值为准，不做单位换算。
- 「等价精简」以声明值的**字符串相等**判定胜出值一致（如 `red` 与 `#f00` 视为不同），且仅保证三个判定属性的全树胜出值（含无声明）不变；为保证穷举可完成，仅接受 ≤40 元素、≤10 条合法规则。
- 「唯一选择器」的段仅取自目标及最近 7 层祖先的类型 / 合法 `#id` / 单个合法 `.class`（id、class 需能构成合法选择器标识符，如 `id="1a"` 不可用），至多 3 段，连接符为后代空格或直接子代 `>`；仅处理 ≤40 个元素的合法 HTML。存在多个同样唯一的候选时按段数最少、字符串长度最短、字典序最小取舍，因此结果不一定是"看起来最语义化"的那个（如唯一类型 `section` 会胜过 `#main p`）。
