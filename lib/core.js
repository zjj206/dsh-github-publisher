import { createHash, randomBytes } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

export const BLOCKED_PATH_PATTERNS = [
  { pattern: /(^|\/)\.env(?:\.|$)/i, reason: 'environment secret file' },
  { pattern: /(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i, reason: 'SSH private key' },
  { pattern: /\.(?:pem|p12|pfx|key)$/i, reason: 'private key or certificate bundle' },
  { pattern: /(^|\/)\.aws\/credentials$/i, reason: 'AWS credentials' },
  { pattern: /(^|\/)\.config\/gcloud\/application_default_credentials\.json$/i, reason: 'Google Cloud credentials' },
  { pattern: /(^|\/)\.npmrc$/i, reason: 'npm credential file' },
  { pattern: /(^|\/)\.pypirc$/i, reason: 'PyPI credential file' },
  { pattern: /(^|\/)credentials(?:\.|$)/i, reason: 'credential-shaped file' },
  { pattern: /(^|\/)secrets?(?:\.|\/|$)/i, reason: 'secret-shaped path' }
]

export function defaultRepositoryName(root) {
  const folder = String(root).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? ''
  return normalizeRepoName(folder.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''))
}

export function normalizeRepoName(value) {
  const name = String(value ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') {
    throw new Error('repository name must be 1-100 characters using letters, numbers, dot, underscore, or hyphen')
  }
  return name
}

export function normalizeOwner(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const owner = String(value).trim()
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new Error('owner must be a valid GitHub user or organization name')
  }
  return owner
}

export function normalizeTag(value) {
  const tag = String(value ?? '').trim()
  if (tag.length === 0 || tag.length > 128 || /[\s~^:?*\[\\]/.test(tag) || tag.startsWith('-') || tag.endsWith('.') || tag.includes('..')) {
    throw new Error('tag is not a safe Git ref name')
  }
  return tag
}

export function resolveProjectPath(value, sessionCwd) {
  const base = sessionCwd || process.cwd()
  const input = String(value ?? '.').trim() || '.'
  return resolve(base, input)
}

export function toGitPath(value) {
  return String(value).replaceAll('\\', '/')
}

export function findBlockedPaths(paths) {
  const findings = []
  for (const raw of paths) {
    const path = toGitPath(raw).replace(/^\.\//, '')
    // Conventional templates contain no runtime secret and are safe to publish.
    if (/(^|\/)\.env(?:\.[^/]+)?\.example$/i.test(path)) continue
    for (const rule of BLOCKED_PATH_PATTERNS) {
      if (rule.pattern.test(path)) {
        findings.push({ path, reason: rule.reason })
        break
      }
    }
  }
  return findings
}

export function buildRepoSlug(owner, repo) {
  return owner ? `${owner}/${repo}` : repo
}

export function expectedConfirmation(repoSlug, visibility, tag) {
  return `PUBLISH ${repoSlug} ${visibility} ${tag}`
}

export function expectedReleaseConfirmation(repoSlug, tag) {
  return `RELEASE ${repoSlug} ${tag}`
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class PreviewStore {
  constructor(ttlMs, now = () => Date.now()) {
    this.ttlMs = ttlMs
    this.now = now
    this.entries = new Map()
  }

  create(kind, data) {
    this.cleanup()
    const token = randomBytes(18).toString('base64url')
    this.entries.set(token, { kind, data, expiresAt: this.now() + this.ttlMs })
    return token
  }

  consume(token, kind) {
    const entry = this.entries.get(token)
    this.entries.delete(token)
    if (!entry || entry.kind !== kind || entry.expiresAt < this.now()) {
      throw new Error('preview token is invalid, expired, already used, or belongs to another action; run the preview again')
    }
    return entry.data
  }

  cleanup() {
    const now = this.now()
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(token)
    }
  }

  clear() {
    this.entries.clear()
  }
}

export function isAbsolutePath(value) {
  return isAbsolute(value)
}
