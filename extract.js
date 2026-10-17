#!/usr/bin/env node
/**
 * 从 web/achieves/{version}.html 中提取版本哈希数据，生成 window.verData 对象。
 * 额外提取 crc_libs，并在输出时给出相邻版本的 hash 变动报告。
 *
 * 用法：
 *   node extract-verdata.js                                  # 默认扫描 web/achieves，打印到 stdout
 *   node extract-verdata.js web/achieves                     # 指定目录
 *   node extract-verdata.js web/achieves verdata.js          # 指定目录 + 输出文件
 *   node extract-verdata.js web/achieves verdata.js --report CHANGES.txt
 *                                                            # 同时把变动报告写入文件
 */
'use strict';

const fsp = require('fs/promises');
const path = require('path');

// jsCrcLibs 加进来，防止 crc_libs 的 hash 后续变动
const HASH_KEYS = ['jsMain', 'jsVendors', 'jsBase', 'jsCrcLibs', 'cssMain', 'cssBase'];
const KEY_TO_FILE = {
    jsMain: 'main.js',
    jsVendors: 'main-vendors.js',
    jsBase: 'base.js',
    jsCrcLibs: 'crc_libs.js',
    cssMain: 'main.css',
    cssBase: 'base.css',
};
const USAGE = `
用法: node extract-verdata.js [目录] [输出文件] [--report 报告文件]

参数:
  目录        包含 {version}.html 的目录，默认 web/achieves
  输出文件    生成的 verData 脚本输出路径，省略则打印到 stdout
  --report    额外把"相邻版本变动报告"写入指定文件（同时始终打印到 stderr）

示例:
  node extract-verdata.js
  node extract-verdata.js web/achieves dist/verdata.js
  node extract-verdata.js web/achieves dist/verdata.js --report dist/CHANGES.txt
`.trim();

/* ---------------------------- 解析 HTML ---------------------------- */

/**
 * 提取 window.verData = {...} 对象。
 * 用花括号配对方式截取字面量，再用 new Function 求值（源文件是自家构建产物，可信任）。
 */
function extractVerDataObject(html) {
    const anchor = html.indexOf('window.verData');
    if (anchor === -1) return null;

    const start = html.indexOf('{', anchor);
    if (start === -1) return null;

    let depth = 0;
    let end = -1;
    for (let i = start; i < html.length; i++) {
        const ch = html[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                end = i + 1;
                break;
            }
        }
    }
    if (end === -1) return null;

    try {
        const obj = new Function(`return (${html.slice(start, end)});`)();
        return obj && typeof obj === 'object' ? obj : null;
    } catch {
        return null;
    }
}

/**
 * 兜底方案：直接从资源 URL 里抠 hash。
 *   .../js/main.xxxxxxxx.js         -> jsMain
 *   .../js/main-vendors.xxxxxxxx.js -> jsVendors
 *   .../js/base.xxxxxxxx.js         -> jsBase
 *   .../js/crc_libs.xxxxxxxx.js     -> jsCrcLibs
 *   .../css/main.xxxxxxxx.css       -> cssMain
 *   .../css/base.xxxxxxxx.css       -> cssBase
 */
function extractFromUrls(html) {
    const re = /\/(?:static\/)?(js|css)\/([A-Za-z0-9_-]+)\.([0-9a-f]{6,})\.(js|css)\b/g;
    const out = {};
    let m;
    while ((m = re.exec(html))) {
        const name = m[2];
        const hash = m[3];
        const ext = m[4];
        let key = null;
        if (ext === 'js') {
            if (name === 'main') key = 'jsMain';
            else if (name === 'main-vendors') key = 'jsVendors';
            else if (name === 'base') key = 'jsBase';
            else if (name === 'crc_libs') key = 'jsCrcLibs';
        } else {
            if (name === 'main') key = 'cssMain';
            else if (name === 'base') key = 'cssBase';
        }
        if (key && !out[key]) out[key] = hash;
    }
    return Object.keys(out).length ? out : null;
}

/** 从单个 HTML 文件拿到该版本的数据 */
function extractFromHtml(html, fileVersion) {
    const obj = extractVerDataObject(html);
    if (obj) {
        if (obj[fileVersion]) return { data: obj[fileVersion], source: 'verData' };
        const firstKey = Object.keys(obj)[0];
        if (firstKey) {
            return {
                data: obj[firstKey],
                source: 'verData',
                warning: `未找到版本键 "${fileVersion}"，回退使用 "${firstKey}"`,
            };
        }
    }
    const fromUrls = extractFromUrls(html);
    if (fromUrls) return { data: fromUrls, source: 'urls' };
    return null;
}

/* ---------------------------- 版本排序 ---------------------------- */

function compareVersionsDesc(a, b) {
    const pa = a.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
    const pb = b.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const d = (pb[i] || 0) - (pa[i] || 0); // 降序
        if (d !== 0) return d;
    }
    return a < b ? 1 : a > b ? -1 : 0;
}

/* ---------------------------- 输出渲染 ---------------------------- */

function render(verData) {
    const lines = ['window.verData = {'];
    for (const ver of Object.keys(verData)) {
        lines.push(`    '${ver}': {`);
        for (const key of HASH_KEYS) {
            const val = verData[ver][key];
            if (val) lines.push(`        ${key}: '${val}',`);
        }
        lines.push('    },');
    }
    lines.push('};');
    return lines.join('\n') + '\n';
}

/**
 * 生成相邻版本变动报告。
 * 输出按版本降序，逐行展示 "当前版本 vs 更旧版本 -> 变动了哪些字段"。
 */
function buildReport(sorted) {
    const versions = Object.keys(sorted);
    if (!versions.length) return '';
    const width = Math.max(...versions.map((v) => v.length));
    const lines = ['版本对比（相对更旧的上一版）：'];
    for (let i = 0; i < versions.length; i++) {
        const cur = versions[i];
        const prev = versions[i + 1];
        if (!prev) {
            lines.push(`  ${cur.padEnd(width)}  （基线，无更旧版本）`);
            continue;
        }
        const changed = HASH_KEYS.filter((k) => sorted[cur][k] !== sorted[prev][k]).map(k => KEY_TO_FILE[k]);
        const label = changed.length ? changed.join(', ') : '(无变动)';
        lines.push(`更新：${label}`);
    }
    return lines.join('\n') + '\n';
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
    const rawArgs = process.argv.slice(2);
    const positional = [];
    let reportFile = null;
    for (let i = 0; i < rawArgs.length; i++) {
        const a = rawArgs[i];
        if (a === '--report' || a === '-r') {
            if (!rawArgs[i + 1]) {
                console.error('[error] --report 缺少文件路径');
                process.exitCode = 1;
                return;
            }
            reportFile = path.resolve(rawArgs[++i]);
        } else if (a === '--help' || a === '-h') {
            console.log(USAGE);
            return;
        } else {
            positional.push(a);
        }
    }

    const dir = path.resolve(positional[0] || 'web/achieves');
    const outFile = positional[1] ? path.resolve(positional[1]) : null;

    let entries;
    try {
        entries = await fsp.readdir(dir);
    } catch (err) {
        console.error(`[error] 无法读取目录 ${dir}: ${err.message}`);
        process.exitCode = 1;
        return;
    }

    const htmlFiles = entries.filter((f) => f.toLowerCase().endsWith('.html')).sort();
    if (htmlFiles.length === 0) {
        console.error(`[error] 目录 ${dir} 中没有 .html 文件`);
        process.exitCode = 1;
        return;
    }

    const verData = Object.create(null);
    const warnings = [];
    let parsed = 0;

    for (const file of htmlFiles) {
        const fileVersion = path.basename(file, path.extname(file));
        const absPath = path.join(dir, file);
        const html = await fsp.readFile(absPath, 'utf8');

        const result = extractFromHtml(html, fileVersion);
        if (!result) {
            warnings.push(`${file}: 未找到 window.verData，也无法从 URL 推断，已跳过`);
            continue;
        }
        if (result.warning) warnings.push(`${file}: ${result.warning}`);

        const clean = {};
        for (const key of HASH_KEYS) {
            const val = result.data[key];
            if (typeof val === 'string' && val) clean[key] = val;
        }
        if (Object.keys(clean).length === 0) {
            warnings.push(`${file}: 解析出的数据为空，已跳过`);
            continue;
        }
        if (verData[fileVersion]) {
            warnings.push(`${fileVersion}: 版本重复，后者覆盖前者`);
        }
        verData[fileVersion] = { ...(verData[fileVersion] || {}), ...clean };
        parsed++;
    }

    // 按版本号降序
    const sorted = {};
    for (const ver of Object.keys(verData).sort(compareVersionsDesc)) {
        sorted[ver] = verData[ver];
    }

    const output = render(sorted);
    const report = buildReport(sorted);

    // 提示信息走 stderr，避免污染 stdout
    for (const w of warnings) console.error(`[warn] ${w}`);
    console.error(`[ok] 解析 ${parsed} 个 HTML，得到 ${Object.keys(sorted).length} 个版本`);

    // 变动报告始终打到 stderr
    if (report) {
        console.error('');
        process.stderr.write(report);
    }

    if (reportFile) {
        await fsp.writeFile(reportFile, report, 'utf8');
        console.error(`\n[ok] 变动报告已写入 ${reportFile}`);
    }

    if (outFile) {
        await fsp.writeFile(outFile, output, 'utf8');
        console.error(`[ok] 已写入 ${outFile}`);
    } else {
        process.stdout.write(output);
    }
}

main().catch((err) => {
    console.error('[error]', err);
    process.exitCode = 1;
});