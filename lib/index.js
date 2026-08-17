import { readdir, stat } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  PreviewStore,
  buildRepoSlug,
  defaultRepositoryName,
  expectedConfirmation,
  expectedReleaseConfirmation,
  findBlockedPaths,
  fingerprint,
  normalizeOwner,
  normalizeRepoName,
  normalizeTag,
  resolveProjectPath,
  toGitPath
} from './core.js'

export const name = 'github-publisher'
export const inject = ['tools', 'subprocess']

export const Config = z.object({
  defaultVisibility: z.union([z.const('public'), z.const('private')]).default('public'),
  previewTtlSeconds: z.number().min(60).max(3600).default(600),
  commandTimeoutMs: z.number().min(1000).max(600000).default(120000),
  maxOutputBytes: z.number().min(4096).max(2097152).default(262144),
  maxScanFiles: z.number().min(100).max(100000).default(20000),
  registerTools: z.boolean().default(true)
})

const OMIT_DIRS = new Set(['.git', 'node_modules', '.pnpm-store', 'dist', 'build', '.next', '.cache', 'coverage'])
const text = (value) => [{ type: 'text', text: value }]

function outputSchema(properties) {
  return { type: 'object', additionalProperties: false, properties }
}

function reqString(description) {
  return { type: 'string', required: true, description }
}

function optString(description) {
  return { type: 'string', description }
}

function sessionCwd(exec) {
  return exec.agent?.session.header.cwd ?? process.cwd()
}

async function scanProject(root, maxFiles) {
  const info = await stat(root).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`project path is not a readable directory: ${root}`)
  const files = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && OMIT_DIRS.has(entry.name)) continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(toGitPath(relative(root, full)))
      if (files.length > maxFiles) throw new Error(`project scan exceeds maxScanFiles (${maxFiles}); narrow the project or raise plugin configuration deliberately`)
    }
  }
  files.sort()
  return { files, blocked: findBlockedPaths(files) }
}

function createRunner(ctx, config) {
  return async function run(command, args, options = {}) {
    const cwd = options.cwd ?? process.cwd()
    const timeout = AbortSignal.timeout(config.commandTimeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const executable = await ctx.subprocess.resolveExecutable(command, undefined, signal)
    const handle = ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: config.maxOutputBytes },
        stderr: { maxBytes: config.maxOutputBytes }
      },
      graceMs: 2000,
      signal
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (!stdout || !stderr) throw new Error(`${command} returned no collected output`)
    if (stdout.lossy || stderr.lossy) throw new Error(`${command} output exceeded maxOutputBytes (${config.maxOutputBytes})`)
    const result = { exitCode: outcome.exitCode, signal: outcome.signal, stdout: stdout.text.trim(), stderr: stderr.text.trim() }
    if (!options.allowFailure && (outcome.exitCode !== 0 || outcome.signal !== null)) {
      const detail = result.stderr || result.stdout || `exit ${String(outcome.exitCode)}`
      throw new Error(`${command} ${args[0] ?? ''} failed: ${detail}`)
    }
    return result
  }
}

async function ghIdentity(run, signal) {
  await run('gh', ['auth', 'status', '--hostname', 'github.com'], { signal })
  const result = await run('gh', ['api', 'user', '--jq', '.login'], { signal })
  if (!result.stdout) throw new Error('GitHub CLI returned no authenticated login')
  return result.stdout
}

async function gitState(run, root, signal) {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, signal, allowFailure: true })
  if (inside.exitCode !== 0) return { initialized: false, branch: 'main', origin: null, changes: [] }
  const branchResult = await run('git', ['branch', '--show-current'], { cwd: root, signal })
  const originResult = await run('git', ['remote', 'get-url', 'origin'], { cwd: root, signal, allowFailure: true })
  const statusResult = await run('git', ['status', '--porcelain=v1'], { cwd: root, signal })
  return {
    initialized: true,
    branch: branchResult.stdout || 'main',
    origin: originResult.exitCode === 0 ? originResult.stdout : null,
    changes: statusResult.stdout ? statusResult.stdout.split(/\r?\n/) : []
  }
}

function assertSafeScan(scan) {
  if (scan.files.length === 0) throw new Error('project contains no publishable files')
  if (scan.blocked.length) {
    const list = scan.blocked.slice(0, 20).map((item) => `${item.path} (${item.reason})`).join(', ')
    throw new Error(`publishing blocked because sensitive-looking files were found: ${list}`)
  }
}

function canonicalRemote(slug) {
  return `https://github.com/${slug}.git`
}

function remoteMatches(remote, slug) {
  if (!remote) return true
  const normalized = remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '').toLowerCase()
  return normalized === `https://github.com/${slug}`.toLowerCase()
}

function publishSnapshot(args, root, owner, repo, visibility, tag, scan, state) {
  return {
    root,
    owner,
    repo,
    slug: buildRepoSlug(owner, repo),
    visibility,
    tag,
    title: String(args.releaseTitle ?? tag).trim() || tag,
    notes: String(args.releaseNotes ?? 'Initial public release.').trim() || 'Initial public release.',
    description: String(args.description ?? '').trim(),
    branch: String(args.branch ?? state.branch ?? 'main').trim() || 'main',
    draft: args.draft === true,
    prerelease: args.prerelease === true,
    commitMessage: String(args.commitMessage ?? `Publish ${tag}`).trim() || `Publish ${tag}`,
    filesFingerprint: fingerprint(scan.files),
    fileCount: scan.files.length,
    existingOrigin: state.origin
  }
}

export function apply(ctx, config) {
  const run = createRunner(ctx, config)
  const previews = new PreviewStore(config.previewTtlSeconds * 1000)
  ctx.effect(() => () => previews.clear())

  ctx.tools.register(defineTool({
    name: 'github_status',
    description: 'Check whether Git and GitHub CLI are available and identify the currently authenticated GitHub account. This never receives or displays a token.',
    parameters: {},
    output: {
      schema: outputSchema({ login: reqString('Authenticated GitHub login.'), git: reqString('Resolved Git executable.'), gh: reqString('Resolved GitHub CLI executable.') }),
      render: (_args, value) => text(`GitHub is ready as @${value.login}.`)
    },
    async execute(_args, exec) {
      const [git, gh, login] = await Promise.all([
        ctx.subprocess.resolveExecutable('git', undefined, exec.signal),
        ctx.subprocess.resolveExecutable('gh', undefined, exec.signal),
        ghIdentity(run, exec.signal)
      ])
      return { login, git, gh }
    },
    isConcurrencySafe: () => true
  }))

  ctx.tools.register(defineTool({
    name: 'github_repo_list',
    description: 'List repositories visible to the authenticated GitHub account. Read-only.',
    parameters: {
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum repositories to return; default 30.' },
      visibility: { type: 'string', enum: ['all', 'public', 'private'], description: 'Visibility filter; default all.' }
    },
    output: {
      schema: outputSchema({ repositories: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { nameWithOwner: reqString('Owner/name.'), visibility: reqString('Visibility.'), url: reqString('Repository URL.'), description: reqString('Description, possibly empty.') } } } }),
      render: (_args, value) => text(value.repositories.length ? value.repositories.map((repo) => `${repo.nameWithOwner} [${repo.visibility}] ${repo.url}`).join('\n') : 'No repositories matched.')
    },
    async execute(args, exec) {
      await ghIdentity(run, exec.signal)
      const limit = args.limit ?? 30
      const argv = ['repo', 'list', '--limit', String(limit), '--json', 'nameWithOwner,visibility,url,description']
      if (args.visibility && args.visibility !== 'all') argv.push('--visibility', args.visibility)
      const result = await run('gh', argv, { signal: exec.signal })
      const parsed = JSON.parse(result.stdout || '[]')
      return { repositories: parsed.map((repo) => ({ nameWithOwner: repo.nameWithOwner, visibility: String(repo.visibility).toLowerCase(), url: repo.url, description: repo.description ?? '' })) }
    },
    isConcurrencySafe: () => true
  }))

  ctx.tools.register(defineTool({
    name: 'github_publish_preview',
    description: 'Preflight a one-click GitHub publication without changing local files or GitHub. It scans for sensitive-looking files, checks Git/GitHub state, and returns a one-use confirmation token and exact phrase. Always call this before github_publish_confirm.',
    parameters: {
      projectPath: optString('Project directory, absolute or relative to the session workspace; default current workspace.'),
      repository: optString('New or existing GitHub repository name. Omit to use the current project folder name.'),
      owner: optString('GitHub user or organization; omit to use the authenticated user.'),
      visibility: { type: 'string', enum: ['public', 'private'], description: 'Repository visibility; defaults to plugin configuration (public).' },
      branch: optString('Branch to push; default current branch or main.'),
      description: optString('Repository description for a newly created repository.'),
      tag: optString('Release tag, for example v1.0.0. Omit to use v0.1.0.'),
      releaseTitle: optString('GitHub Release title; default tag.'),
      releaseNotes: optString('GitHub Release notes; default a short initial-release note.'),
      commitMessage: optString('Commit message used when the project has uncommitted content.'),
      draft: { type: 'boolean', description: 'Create the Release as a draft; default false.' },
      prerelease: { type: 'boolean', description: 'Mark the Release as a prerelease; default false.' }
    },
    output: {
      schema: outputSchema({ previewToken: reqString('One-use preview token.'), confirmation: reqString('Exact confirmation phrase.'), repository: reqString('Target owner/name.'), projectPath: reqString('Resolved project directory.'), visibility: reqString('Target visibility.'), tag: reqString('Release tag.'), fileCount: { type: 'integer', required: true }, summary: reqString('Human-readable preflight summary.') }),
      render: (_args, value) => text(`${value.summary}\nTo execute, call github_publish_confirm with token ${value.previewToken} and exact confirmation: ${value.confirmation}`)
    },
    async execute(args, exec) {
      const root = resolveProjectPath(args.projectPath, sessionCwd(exec))
      const repo = args.repository === undefined || String(args.repository).trim() === '' ? defaultRepositoryName(root) : normalizeRepoName(args.repository)
      const requestedOwner = normalizeOwner(args.owner)
      const login = await ghIdentity(run, exec.signal)
      const owner = requestedOwner ?? login
      const visibility = args.visibility ?? config.defaultVisibility
      const tag = normalizeTag(args.tag ?? 'v0.1.0')
      const [scan, state] = await Promise.all([scanProject(root, config.maxScanFiles), gitState(run, root, exec.signal)])
      assertSafeScan(scan)
      const slug = buildRepoSlug(owner, repo)
      if (!remoteMatches(state.origin, slug)) throw new Error(`existing origin points elsewhere (${state.origin}); refusing to replace it with ${slug}`)
      const snapshot = publishSnapshot(args, root, owner, repo, visibility, tag, scan, state)
      const previewToken = previews.create('publish', snapshot)
      const confirmation = expectedConfirmation(slug, visibility, tag)
      return {
        previewToken,
        confirmation,
        repository: slug,
        projectPath: root,
        visibility,
        tag,
        fileCount: scan.files.length,
        summary: `Ready to publish ${scan.files.length} files from ${root} to ${slug} as ${visibility}, push branch ${snapshot.branch}, and create Release ${tag}. No blocked secret-shaped paths were found.`
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'github_publish_confirm',
    description: 'Execute a previously previewed one-click publication. This creates or updates the GitHub repository, stages and commits local files, pushes the branch, sets visibility, and creates a GitHub Release. It requires the one-use token and exact confirmation phrase from github_publish_preview.',
    parameters: {
      previewToken: reqString('One-use token returned by github_publish_preview.'),
      confirmation: reqString('Exact confirmation phrase returned by github_publish_preview.')
    },
    output: {
      schema: outputSchema({ repository: reqString('Published owner/name.'), repositoryUrl: reqString('Repository URL.'), releaseUrl: reqString('Release URL.'), branch: reqString('Pushed branch.'), tag: reqString('Release tag.'), createdRepository: { type: 'boolean', required: true }, message: reqString('Publication result.') }),
      render: (_args, value) => text(`${value.message}\nRepository: ${value.repositoryUrl}\nRelease: ${value.releaseUrl}`)
    },
    async execute(args, exec) {
      const plan = previews.consume(args.previewToken, 'publish')
      const expected = expectedConfirmation(plan.slug, plan.visibility, plan.tag)
      if (args.confirmation !== expected) throw new Error(`confirmation mismatch; expected exactly: ${expected}`)
      await ghIdentity(run, exec.signal)
      const scan = await scanProject(plan.root, config.maxScanFiles)
      assertSafeScan(scan)
      if (fingerprint(scan.files) !== plan.filesFingerprint) throw new Error('project file list changed after preview; run github_publish_preview again')
      const current = await gitState(run, plan.root, exec.signal)
      if (!remoteMatches(current.origin, plan.slug)) throw new Error(`origin changed after preview and points elsewhere (${current.origin}); publication stopped`)

      if (!current.initialized) await run('git', ['init', '-b', plan.branch], { cwd: plan.root, signal: exec.signal })
      await run('git', ['add', '-A'], { cwd: plan.root, signal: exec.signal })
      const staged = await run('git', ['diff', '--cached', '--quiet'], { cwd: plan.root, signal: exec.signal, allowFailure: true })
      if (staged.exitCode !== 0) await run('git', ['commit', '-m', plan.commitMessage], { cwd: plan.root, signal: exec.signal })
      const head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: plan.root, signal: exec.signal, allowFailure: true })
      if (head.exitCode !== 0) throw new Error('project has no commit to publish')

      const exists = await run('gh', ['repo', 'view', plan.slug, '--json', 'url'], { signal: exec.signal, allowFailure: true })
      const createdRepository = exists.exitCode !== 0
      if (createdRepository) {
        const createArgs = ['repo', 'create', plan.slug, `--${plan.visibility}`, '--source', plan.root, '--remote', 'origin']
        if (plan.description) createArgs.push('--description', plan.description)
        await run('gh', createArgs, { signal: exec.signal })
      } else if (!current.origin) {
        await run('git', ['remote', 'add', 'origin', canonicalRemote(plan.slug)], { cwd: plan.root, signal: exec.signal })
      }

      const editArgs = ['repo', 'edit', plan.slug, '--visibility', plan.visibility]
      if (plan.visibility === 'public') editArgs.push('--accept-visibility-change-consequences')
      if (plan.description) editArgs.push('--description', plan.description)
      await run('gh', editArgs, { signal: exec.signal })
      await run('git', ['push', '-u', 'origin', `HEAD:${plan.branch}`], { cwd: plan.root, signal: exec.signal })

      const releaseArgs = ['release', 'create', plan.tag, '--repo', plan.slug, '--target', plan.branch, '--title', plan.title, '--notes', plan.notes]
      if (plan.draft) releaseArgs.push('--draft')
      if (plan.prerelease) releaseArgs.push('--prerelease')
      await run('gh', releaseArgs, { signal: exec.signal })
      const repoResult = await run('gh', ['repo', 'view', plan.slug, '--json', 'url', '--jq', '.url'], { signal: exec.signal })
      const releaseResult = await run('gh', ['release', 'view', plan.tag, '--repo', plan.slug, '--json', 'url', '--jq', '.url'], { signal: exec.signal })
      return {
        repository: plan.slug,
        repositoryUrl: repoResult.stdout,
        releaseUrl: releaseResult.stdout,
        branch: plan.branch,
        tag: plan.tag,
        createdRepository,
        message: `Published ${plan.slug} and created Release ${plan.tag}.`
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'github_release_preview',
    description: 'Preview creating a GitHub Release for an already pushed repository. Read-only; returns a one-use token and exact confirmation phrase.',
    parameters: {
      repository: reqString('Repository as owner/name.'),
      tag: reqString('Release tag.'),
      title: optString('Release title; default tag.'),
      notes: optString('Release notes.'),
      target: optString('Target branch or commit; omit for repository default.'),
      draft: { type: 'boolean', description: 'Create a draft Release.' },
      prerelease: { type: 'boolean', description: 'Create a prerelease.' }
    },
    output: {
      schema: outputSchema({ previewToken: reqString('One-use token.'), confirmation: reqString('Exact confirmation phrase.'), repository: reqString('Target owner/name.'), tag: reqString('Release tag.'), summary: reqString('Preview summary.') }),
      render: (_args, value) => text(`${value.summary}\nTo execute, call github_release_confirm with token ${value.previewToken} and exact confirmation: ${value.confirmation}`)
    },
    async execute(args, exec) {
      await ghIdentity(run, exec.signal)
      const parts = String(args.repository).trim().split('/')
      if (parts.length !== 2) throw new Error('repository must use owner/name format')
      const owner = normalizeOwner(parts[0])
      const repo = normalizeRepoName(parts[1])
      const slug = buildRepoSlug(owner, repo)
      const tag = normalizeTag(args.tag)
      await run('gh', ['repo', 'view', slug, '--json', 'url'], { signal: exec.signal })
      const exists = await run('gh', ['release', 'view', tag, '--repo', slug], { signal: exec.signal, allowFailure: true })
      if (exists.exitCode === 0) throw new Error(`Release ${tag} already exists in ${slug}`)
      const plan = { slug, tag, title: String(args.title ?? tag).trim() || tag, notes: String(args.notes ?? '').trim(), target: args.target ? String(args.target).trim() : '', draft: args.draft === true, prerelease: args.prerelease === true }
      const previewToken = previews.create('release', plan)
      const confirmation = expectedReleaseConfirmation(slug, tag)
      return { previewToken, confirmation, repository: slug, tag, summary: `Ready to create ${plan.draft ? 'draft ' : ''}Release ${tag} in ${slug}${plan.target ? ` targeting ${plan.target}` : ''}.` }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'github_release_confirm',
    description: 'Create a GitHub Release from a github_release_preview token. Requires the exact confirmation phrase and performs an external GitHub write.',
    parameters: {
      previewToken: reqString('One-use token returned by github_release_preview.'),
      confirmation: reqString('Exact confirmation phrase returned by github_release_preview.')
    },
    output: {
      schema: outputSchema({ repository: reqString('Target owner/name.'), tag: reqString('Release tag.'), releaseUrl: reqString('Created Release URL.'), message: reqString('Result message.') }),
      render: (_args, value) => text(`${value.message}\n${value.releaseUrl}`)
    },
    async execute(args, exec) {
      const plan = previews.consume(args.previewToken, 'release')
      const expected = expectedReleaseConfirmation(plan.slug, plan.tag)
      if (args.confirmation !== expected) throw new Error(`confirmation mismatch; expected exactly: ${expected}`)
      await ghIdentity(run, exec.signal)
      const argv = ['release', 'create', plan.tag, '--repo', plan.slug, '--title', plan.title, '--notes', plan.notes]
      if (plan.target) argv.push('--target', plan.target)
      if (plan.draft) argv.push('--draft')
      if (plan.prerelease) argv.push('--prerelease')
      await run('gh', argv, { signal: exec.signal })
      const result = await run('gh', ['release', 'view', plan.tag, '--repo', plan.slug, '--json', 'url', '--jq', '.url'], { signal: exec.signal })
      return { repository: plan.slug, tag: plan.tag, releaseUrl: result.stdout, message: `Created Release ${plan.tag} in ${plan.slug}.` }
    }
  }))
}
