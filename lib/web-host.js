import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { PreviewStore, expectedConfirmation, findBlockedPaths, fingerprint, normalizeRepoName, normalizeTag, toGitPath } from './core.js'

const exec = promisify(execFile)
const ROUTE = '/_dsh/github-publisher'
const OMIT = new Set(['.git', 'node_modules', '.pnpm-store', 'dist', 'build', '.next', '.cache', 'coverage'])

export const name = 'github-publisher-web'

function resolvedConfig(input) {
  return {
    defaultProjectPath: typeof input?.defaultProjectPath === 'string' ? input.defaultProjectPath : '.',
    previewTtlSeconds: Number.isFinite(input?.previewTtlSeconds) ? input.previewTtlSeconds : 600,
    commandTimeoutMs: Number.isFinite(input?.commandTimeoutMs) ? input.commandTimeoutMs : 120000,
    maxScanFiles: Number.isSafeInteger(input?.maxScanFiles) ? input.maxScanFiles : 20000
  }
}

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
  })
  res.end(bytes)
}

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (!origin || !req.headers.host) return false
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

async function body(req, max = 65536) {
  if ((req.headers['content-type'] || '').split(';', 1)[0] !== 'application/json') throw new Error('Content-Type must be application/json')
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('request too large'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function run(command, args, cwd, timeout) {
  try {
    const result = await exec(command, args, { cwd, timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 })
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
  } catch (error) {
    return { ok: false, stdout: String(error.stdout || '').trim(), stderr: String(error.stderr || error.message || '').trim() }
  }
}

async function scan(root, limit) {
  const info = await stat(root).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`项目目录不存在：${root}`)
  const files = []; const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && OMIT.has(entry.name)) continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(toGitPath(relative(root, full)))
      if (files.length > limit) throw new Error(`文件数超过安全上限 ${limit}`)
    }
  }
  files.sort()
  const blocked = findBlockedPaths(files)
  if (!files.length) throw new Error('项目中没有可发布文件')
  if (blocked.length) throw new Error(`发现敏感文件，已阻止发布：${blocked.slice(0, 10).map(x => x.path).join(', ')}`)
  return files
}

async function login(timeout) {
  const result = await run('gh', ['api', 'user', '--jq', '.login'], process.cwd(), timeout)
  if (!result.ok || !result.stdout) throw new Error('GitHub CLI 尚未登录，请先运行 gh auth login')
  return result.stdout
}

export function apply(ctx, input) {
  const config = resolvedConfig(input)
  const previews = new PreviewStore(config.previewTtlSeconds * 1000)
  ctx.effect(() => () => previews.clear())
  ctx.inject(['webServer'], webCtx => webCtx.effect(() => webCtx.webServer.register({
    kind: 'exact', path: ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只允许 POST' })
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: '拒绝跨站请求' })
      try {
        const input = await body(req)
        const account = await login(config.commandTimeoutMs)
        if (input.action === 'status') return json(res, 200, { ok: true, account, defaultProjectPath: resolve(config.defaultProjectPath) })
        if (input.action === 'preview') {
          const root = resolve(String(input.projectPath || config.defaultProjectPath))
          const repo = normalizeRepoName(String(input.repository || basename(root)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-'))
          const visibility = input.visibility === 'private' ? 'private' : 'public'
          const tag = normalizeTag(input.tag || 'v0.1.0')
          const files = await scan(root, config.maxScanFiles)
          const slug = `${account}/${repo}`
          const plan = { root, repo, slug, visibility, tag, title: String(input.title || tag), notes: String(input.notes || 'Initial release.'), fileHash: fingerprint(files), fileCount: files.length }
          const token = previews.create('web-publish', plan)
          return json(res, 200, { ok: true, token, confirmation: expectedConfirmation(slug, visibility, tag), plan })
        }
        if (input.action === 'confirm') {
          const plan = previews.consume(String(input.token || ''), 'web-publish')
          const expected = expectedConfirmation(plan.slug, plan.visibility, plan.tag)
          if (input.confirmation !== expected) throw new Error('确认信息不匹配，请重新预检')
          const files = await scan(plan.root, config.maxScanFiles)
          if (fingerprint(files) !== plan.fileHash) throw new Error('项目文件在预检后发生变化，请重新预检')
          const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], plan.root, config.commandTimeoutMs)
          if (!inside.ok) { const init = await run('git', ['init', '-b', 'main'], plan.root, config.commandTimeoutMs); if (!init.ok) throw new Error(init.stderr) }
          let step = await run('git', ['add', '-A'], plan.root, config.commandTimeoutMs); if (!step.ok) throw new Error(step.stderr)
          const diff = await run('git', ['diff', '--cached', '--quiet'], plan.root, config.commandTimeoutMs)
          if (!diff.ok) { step = await run('git', ['commit', '-m', `Publish ${plan.tag}`], plan.root, config.commandTimeoutMs); if (!step.ok) throw new Error(step.stderr) }
          const exists = await run('gh', ['repo', 'view', plan.slug, '--json', 'url'], plan.root, config.commandTimeoutMs)
          if (!exists.ok) { step = await run('gh', ['repo', 'create', plan.slug, `--${plan.visibility}`, '--source', plan.root, '--remote', 'origin'], plan.root, config.commandTimeoutMs); if (!step.ok) throw new Error(step.stderr) }
          const branch = await run('git', ['branch', '--show-current'], plan.root, config.commandTimeoutMs)
          const branchName = branch.stdout || 'main'
          step = await run('git', ['push', '-u', 'origin', `HEAD:${branchName}`], plan.root, config.commandTimeoutMs); if (!step.ok) throw new Error(step.stderr)
          step = await run('gh', ['release', 'create', plan.tag, '--repo', plan.slug, '--target', branchName, '--title', plan.title, '--notes', plan.notes], plan.root, config.commandTimeoutMs); if (!step.ok) throw new Error(step.stderr)
          const url = await run('gh', ['release', 'view', plan.tag, '--repo', plan.slug, '--json', 'url', '--jq', '.url'], plan.root, config.commandTimeoutMs)
          return json(res, 200, { ok: true, repositoryUrl: `https://github.com/${plan.slug}`, releaseUrl: url.stdout })
        }
        throw new Error('未知操作')
      } catch (error) { json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
    }
  }), 'github-publisher:web-route'))
}
