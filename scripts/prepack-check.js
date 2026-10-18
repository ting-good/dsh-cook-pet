#!/usr/bin/env node
/**
 * 发布前自检（`npm run pack:check`，`prepack` 时也会自动跑）
 *
 * 为什么需要它：这个插件的失败**几乎全是静默的** —— 装上了但没有桌宠、有桌宠但没有声音、
 * 桌面窗黑屏、`file:` 安装拿到的还是旧副本…… 控制台往往干干净净。
 * 所以把"装到别人机器上才会炸"的那些条件逐条前置检查，让问题在打包前就爆出来。
 *
 * 逐项检查（任何一项失败都直接退出非 0，不静默放过）：
 *   1. 包清单：name / version / main / dsh.bundle.patch，且**不得**声明 dsh.client
 *      （本插件只有桌面置顶窗，没有浏览器半侧；声明了会让 DSH 加载不存在的 client.js）
 *   2. 宿主入口：能被 import，且导出 name / inject / apply（Cordis 插件形状）
 *   3. bundle patch：id 与包名一致、`id: 值` 那行不能有行尾注释（商城预检按正则抓值）
 *   4. 素材：6 个透明 webm 齐全且非空、图标存在且 ≤256KiB
 *   5. 桌面 helper：Electron 侧需要的文件齐全
 *   6. 桌面窗渲染端：纯 JS（不能有 import/export），只经 petBridge 通信
 *   7. 零运行时依赖：插件由 DSH 直接加载，不装 node_modules
 *   8. `files` 白名单覆盖了所有运行时必需文件（npm publish 不会把漏掉的文件带上）
 *
 * 用法：
 *   node scripts/prepack-check.js          # 自检当前目录
 *   node scripts/prepack-check.js <目录>    # 自检指定目录（例如部署后的副本）
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.argv[2] ?? join(HERE, '..'));

/** 收集失败项；跑完一次性报告，比"遇到第一个就退出"更适合做体检 */
const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => notes.push('  ✓ ' + msg);

function read(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    fail(`缺少文件：${rel}`);
    return '';
  }
  return readFileSync(p, 'utf8');
}

// ---------------------------------------------------------------------------
// 1. 包清单
// ---------------------------------------------------------------------------
const pkgRaw = read('package.json');
let pkg = {};
try {
  pkg = JSON.parse(pkgRaw);
} catch (e) {
  fail('package.json 不是合法 JSON：' + e.message);
}

if (pkg.name !== 'dsh-cook-pet') fail(`包名应为 dsh-cook-pet，实际 ${JSON.stringify(pkg.name)}`);
else ok('包名 dsh-cook-pet');
if (!/^\d+\.\d+\.\d+/.test(String(pkg.version ?? ''))) fail('version 不是语义化版本号');
else ok(`版本 ${pkg.version}`);
if (pkg.type !== 'module') fail('package.json 必须有 "type": "module"（宿主是纯 ESM）');
if (pkg.main !== 'lib/index.js') fail(`main 应为 lib/index.js，实际 ${JSON.stringify(pkg.main)}`);

// ★ 本插件**只有宿主侧**：照照只以独立 Electron 置顶窗存在，没有浏览器半侧。
//   所以这里必须确认"没有声明浏览器半侧" —— 声明了 dsh.client 却没有对应文件，
//   DSH 会去加载 /plugins/<name>/client.js 并失败，表现是整个插件不工作。
if (pkg.dsh?.client !== undefined) {
  fail('不应声明 dsh.client（本插件没有浏览器半侧；声明了会让 DSH 去加载不存在的 client.js）');
} else ok('未声明 dsh.client（只有桌面置顶窗，无浏览器半侧）');
if (pkg.exports?.['./client'] !== undefined) {
  fail('不应导出 ./client（浏览器半侧已移除）');
} else ok('未导出 ./client');
if (existsSync(join(ROOT, 'lib/client.js'))) {
  fail('lib/client.js 应已删除（浏览器半侧已移除）');
}

if (pkg.exports?.['./cordis.patch.yml'] === undefined) fail('exports 里应导出 cordis.patch.yml');
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch 应指向 ./cordis.patch.yml');
if (pkg.icon !== 'assets/icon.png') fail('icon 应指向 assets/icon.png');

// ---------------------------------------------------------------------------
// 2. 宿主入口形状
// ---------------------------------------------------------------------------
const entryPath = join(ROOT, String(pkg.main ?? 'lib/index.js'));
if (existsSync(entryPath)) {
  try {
    const mod = await import(pathToFileURL(entryPath).href);
    if (mod.name !== pkg.name) fail(`入口导出的 name 应与包名一致，实际 ${JSON.stringify(mod.name)}`);
    if (typeof mod.apply !== 'function') fail('入口必须导出 apply(ctx)');
    if (!Array.isArray(mod.inject)) fail('入口必须导出 inject 数组（要注入的服务）');
    if (failures.length === 0) ok(`宿主入口可加载（inject: ${JSON.stringify(mod.inject)}）`);
  } catch (e) {
    fail('入口 import 失败：' + (e instanceof Error ? e.message : String(e)));
  }
}

// ---------------------------------------------------------------------------
// 3. bundle patch
// ---------------------------------------------------------------------------
const patch = read('cordis.patch.yml');
if (patch !== '') {
  // 硬契约：id 那一行**不能有行尾注释**（商城预检用正则抓值并要求其后直接换行）
  const idLine = patch.split(/\r?\n/).find((l) => /^\s*-\s*id:\s*dsh-cook-pet\s*$/.test(l));
  if (idLine === undefined) {
    const badLine = patch.split(/\r?\n/).find((l) => /^\s*-\s*id:\s*dsh-cook-pet\s*#/.test(l));
    fail(
      badLine === undefined
        ? 'cordis.patch.yml 里找不到 `- id: dsh-cook-pet`'
        : '`- id: dsh-cook-pet` 那行不能写行尾注释（商城预检会抓不到 entry ID）',
    );
  } else {
    ok('patch id 与包名一致，且没有行尾注释');
  }
  if (!/^\s*name:\s*dsh-cook-pet\s*$/m.test(patch)) fail('patch 里应有一行 `name: dsh-cook-pet`');
}

// ---------------------------------------------------------------------------
// 4. 素材与图标
// ---------------------------------------------------------------------------
const ASSET_NAMES = ['idle.webm', 'cook.webm', 'serve.webm', 'think.webm', 'wink.webm', 'spin.webm'];
for (const f of ASSET_NAMES) {
  const p = join(ROOT, 'assets', 'pet', f);
  if (!existsSync(p)) {
    fail(`缺少素材 assets/pet/${f}（先跑 npm run assets）`);
    continue;
  }
  const size = statSync(p).size;
  if (size < 10_000) fail(`素材 assets/pet/${f} 只有 ${size} 字节，像是空了或编码失败`);
}
if (notes.some((n) => n.includes('assets/pet')) === false) ok('6 个透明素材齐全');

const iconPath = join(ROOT, 'assets', 'icon.png');
if (!existsSync(iconPath)) fail('缺少图标 assets/icon.png');
else {
  const size = statSync(iconPath).size;
  if (size > 256 * 1024) fail(`图标 ${size} 字节，超过 256KiB 上限`);
  else ok(`图标 ${Math.round(size / 1024)}KiB`);
}

// ---------------------------------------------------------------------------
// 5. 桌面 helper（Electron 侧）
// ---------------------------------------------------------------------------
for (const f of ['main.js', 'renderer.js', 'preload.js', 'index.html', 'package.json']) {
  if (!existsSync(join(ROOT, 'runtime', 'electron-helper', f))) {
    fail(`桌面 helper 缺少 runtime/electron-helper/${f}`);
  }
}
if (!failures.some((f) => f.includes('electron-helper'))) ok('桌面 helper 文件齐全');

// ---------------------------------------------------------------------------
// 6. 桌面窗渲染端：纯 JS（不经打包器）
// ---------------------------------------------------------------------------
// 浏览器半侧已移除，现在唯一的 UI 是 runtime/electron-helper 里的桌面窗。
// 它同样是"直接丢给 Chromium 执行"的经典脚本，所以不能出现顶层 import/export。
const rendererSrc = read('runtime/electron-helper/renderer.js');
if (rendererSrc !== '') {
  if (/^\s*import\s/m.test(rendererSrc)) fail('renderer.js 不能有 import 语句（不经打包器处理）');
  if (/^\s*export\s/m.test(rendererSrc)) fail('renderer.js 不能有 export 语句（经典脚本）');
  if (!rendererSrc.includes('petBridge')) fail('renderer.js 应通过 preload 暴露的 petBridge 与主进程通信');
  if (failures.length === 0) ok('桌面窗渲染端是纯 JS 且只经 petBridge 通信');
}

// ---------------------------------------------------------------------------
// 7. 零运行时依赖
// ---------------------------------------------------------------------------
const deps = Object.keys(pkg.dependencies ?? {});
const peer = Object.keys(pkg.peerDependencies ?? {});
if (deps.length > 0) fail(`不应有运行时依赖（DSH 直接加载源码，不装 node_modules）：${deps.join(', ')}`);
if (peer.length > 0) fail(`不应有 peerDependencies：${peer.join(', ')}`);
if (deps.length === 0 && peer.length === 0) ok('无运行时依赖');

// ---------------------------------------------------------------------------
// 8. files 白名单覆盖运行时必需文件
// ---------------------------------------------------------------------------
const files = Array.isArray(pkg.files) ? pkg.files : [];
if (files.length === 0) fail('package.json 缺少 files 白名单（npm publish 会把整个仓库发出去）');
else {
  const required = [
    'lib',
    'runtime/electron-helper',
    'assets/pet',
    'assets/icon.png',
    'scripts/ensure-electron.mjs',
    'cordis.patch.yml',
  ];
  for (const r of required) {
    if (!files.includes(r)) fail(`files 白名单缺少 ${r}（发布出去会缺文件）`);
  }
  ok('files 白名单覆盖运行时必需文件');
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
console.log('\n[dsh-cook-pet] 发布自检 —— ' + ROOT + '\n');
for (const n of notes) console.log(n);

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项未通过：`);
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('\n修完再打包；这些错误在运行时几乎都是静默的。');
  process.exit(1);
}
console.log('\n✓ 全部通过，可以打包/发布了。\n');
