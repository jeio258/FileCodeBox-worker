#!/usr/bin/env node
/**
 * 部署前自检：`wrangler deploy` 会以 wrangler.jsonc 为唯一来源覆盖普通变量，
 * 控制台手动添加的明文变量会被清除。此脚本提示不可恢复项（真正兜底在 D1）。
 *
 * - Secret（wrangler secret put）不会被部署覆盖
 * - 应用侧另有 D1 密码哈希兜底，因此 Secret 缺失只警告、不阻断
 */
import { execFileSync } from 'node:child_process';

const warn = (msg) => console.warn(`\x1b[33m[preflight] ${msg}\x1b[0m`);

let secrets = '';
try {
  secrets = execFileSync('npx', ['wrangler', 'secret', 'list'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  // 未登录或网络失败不应阻断部署流程
  warn(`无法读取 Secret 列表（${e.message?.split('\n')[0] ?? 'unknown'}），跳过检查`);
  process.exit(0);
}

let names = [];
try {
  names = JSON.parse(secrets).map((s) => s.name);
} catch {
  names = secrets.split('\n').map((l) => l.trim()).filter(Boolean);
}

if (!names.includes('ADMIN_PASSWORD')) {
  warn('未检测到 Secret ADMIN_PASSWORD：');
  warn('  · 若已在 D1 通过 /api/admin/password 设置过密码，可忽略（D1 哈希兜底）');
  warn('  · 否则部署后仍无法登录；部署后访问 /api/status 查看 adminPasswordConfigured');
  warn('  · 设置方式：npx wrangler secret put ADMIN_PASSWORD');
} else {
  console.log('[preflight] Secret ADMIN_PASSWORD 已配置');
}

console.log('[preflight] 提示：wrangler.jsonc 的 vars 每次部署覆盖；可编辑配置请用管理端（存 D1）');
