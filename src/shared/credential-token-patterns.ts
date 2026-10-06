// Credential shapes shared by the diagnostic-bundle redactor and crash-report
// sanitizer. Tags are stable wire identifiers ("[redacted:<tag>]") that
// third-party NDJSON tools grep for; only add, never rename.

export type CredentialTokenPattern = { readonly tag: string; readonly re: RegExp }

// Most-specific first: `sk-ant-` before `sk-`, `github_pat_` before the `gh?_` family.
// `\b` keeps prose like `risk-assessment-...` or `npm_config_cache` from matching.
export const CREDENTIAL_TOKEN_PATTERNS: readonly CredentialTokenPattern[] = [
  { tag: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { tag: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { tag: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { tag: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { tag: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { tag: 'linear-key', re: /\blin_api_[A-Za-z0-9]{32,}/g },
  { tag: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36,}/g },
  { tag: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { tag: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { tag: 'aws-secret-access-key', re: /aws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}/gi },
  { tag: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { tag: 'slack-token', re: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g },
  // Lazy `[\s\S]+?` so two back-to-back PEM blocks redact independently, not as one gobbled span.
  { tag: 'pem', re: /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g }
]

// Whole Cookie/Set-Cookie header value. Requires a `name=` right after the colon
// so prose like "failed to set cookie: domain mismatch" is left alone.
export const COOKIE_HEADER_PATTERN = /\b(set-cookie|cookie)\s*:\s*[^\s=;:,"']+=[^\r\n]*/gi
