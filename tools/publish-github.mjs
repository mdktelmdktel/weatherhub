#!/usr/bin/env node
/**
 * publish-github.mjs — 把仓库源码/APK 通过 GitHub REST API 发布到指定仓库。
 * 适用场景：github.com:443 被网络屏蔽、但 api.github.com 可达。
 * 用法： node tools/publish-github.mjs [commit message]
 * 凭据： /root/.gh-token（PAT，repo scope；不会打印）
 */
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const TOKEN = (await fs.readFile("/root/.gh-token", "utf8")).trim();
const API = "https://api.github.com";
const H = { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "weatherhub-publisher", "X-GitHub-Api-Version": "2022-11-28" };

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "build", "lib", ".cache", "tmp"]);
const EXCLUDE_FILE = [/.log$/, /\.DS_Store$/, /^SPEC\.md$/, /^package-lock\.json$/];
const SKIP_PATH_PREFIX = ["tools/lib/", "research/cma_home.html", "research/cma_city.html"];

async function walk(dir, rel = "") {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const r = rel ? rel + "/" + ent.name : ent.name;
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      out.push(...await walk(path.join(dir, ent.name), r));
    } else if (ent.isFile()) {
      if (EXCLUDE_FILE.some((re) => re.test(ent.name))) continue;
      if (SKIP_PATH_PREFIX.some((p) => r.startsWith(p) || r === p)) continue;
      out.push(r);
    }
  }
  return out;
}

async function api(url, opts = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url.startsWith("http") ? url : API + url, { ...opts, headers: { ...H, ...(opts.headers || {}) }, signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (res.status >= 500 && i < retries) { await new Promise(r => setTimeout(r, 1500)); continue; }
      return { status: res.status, body };
    } catch (e) { if (i === retries) throw e; await new Promise(r => setTimeout(r, 1500)); }
  }
}

const user = await api("/user");
if (user.status !== 200) throw new Error("auth failed: " + JSON.stringify(user.body).slice(0, 300));
const owner = user.body.login;
const repoName = "weatherhub";
let repo = await api(`/repos/${owner}/${repoName}`);
if (repo.status === 404) {
  repo = await api("/user/repos", { method: "POST", body: JSON.stringify({ name: repoName, description: "天气汇 · 多源天气聚合 Android App（自动定位 + 中国气象局/Open-Meteo/MET Norway/wttr.in 综合展示）", private: false, has_issues: true, has_wiki: false, auto_init: false }) });
  if (repo.status !== 201) throw new Error("create repo failed: " + JSON.stringify(repo.body).slice(0, 300));
}

const REPO = `/repos/${owner}/${repoName}`;
const branch = repo.body.default_branch || "main";
// 空仓库无法直接建 blob：先用 Contents API 提交一个种子文件。
// 注意 GitHub 的 repo.size 有延迟，不能用 size 判断，直接看分支 ref。
const refProbe = await api(`${REPO}/git/ref/heads/${branch}`);
if (refProbe.status === 404) {
  const seed = await api(`${REPO}/contents/README.md`, { method: "PUT", body: JSON.stringify({ message: "chore: init repository", content: Buffer.from("# WeatherHub\n\n初始化仓库，随后推送完整源码。\n").toString("base64") }) });
  if (seed.status !== 200 && seed.status !== 201) throw new Error("seed failed: " + JSON.stringify(seed.body).slice(0, 300));
  console.log("seeded empty repo via Contents API");
}
const files = await walk(ROOT);
console.log(`${owner}/${repoName}: ${files.length} files to publish`);

// 1) blobs
const treeEntries = [];
let total = 0;
for (const f of files.sort()) {
  const buf = await fs.readFile(path.join(ROOT, f));
  total += buf.length;
  const blob = await api(`${REPO}/git/blobs`, { method: "POST", body: JSON.stringify({ content: buf.toString("base64"), encoding: "base64" }) });
  if (blob.status !== 201) throw new Error("blob failed " + f + ": " + JSON.stringify(blob.body).slice(0, 200));
  treeEntries.push({ path: f, mode: "100644", type: "blob", sha: blob.body.sha });
  process.stdout.write(".");
}
console.log(`\n${(total / 1024 / 1024).toFixed(2)} MB uploaded as blobs`);

// 2) tree / commit / ref
const tree = await api(`${REPO}/git/trees`, { method: "POST", body: JSON.stringify({ tree: treeEntries }) });
if (tree.status !== 201) throw new Error("tree failed: " + JSON.stringify(tree.body).slice(0, 300));

let parentSha = null;
const ref = await api(`${REPO}/git/ref/heads/${branch}`);
if (ref.status === 200) parentSha = ref.body.object.sha;

const msg = process.argv.slice(2).join(" ") || "chore: update WeatherHub source";
const commit = await api(`${REPO}/git/commits`, { method: "POST", body: JSON.stringify({ message: msg, tree: tree.body.sha, parents: parentSha ? [parentSha] : [] }) });
if (commit.status !== 201) throw new Error("commit failed: " + JSON.stringify(commit.body).slice(0, 300));

if (parentSha) {
  const upd = await api(`${REPO}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.body.sha, force: false }) });
  if (upd.status !== 200) throw new Error("ref update failed: " + JSON.stringify(upd.body).slice(0, 300));
} else {
  const created = await api(`${REPO}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.body.sha }) });
  if (created.status !== 201) throw new Error("ref create failed: " + JSON.stringify(created.body).slice(0, 300));
  try { await api(`/repos/${owner}/${repoName}`, { method: "PATCH", body: JSON.stringify({ default_branch: "main" }) }); } catch {}
}

console.log(`✅ pushed: https://github.com/${owner}/${repoName}/commit/${commit.body.sha}`);
console.log(`   repo: https://github.com/${owner}/${repoName}`);
