// Shared by the diagnostic-bundle and crash-report redactor tests. Secrets are
// assembled at runtime so repository secret scanners do not flag the fixtures.

const alnum = (length: number): string =>
  'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z'.repeat(Math.ceil(length / 31)).slice(0, length)

export type CredentialLeakCase = {
  readonly label: string
  readonly text: string
  /** Substring that must not survive redaction. */
  readonly secret: string
}

function leak(label: string, secret: string, wrap: (secret: string) => string): CredentialLeakCase {
  return { label, secret, text: wrap(secret) }
}

export const CREDENTIAL_LEAK_CASES: readonly CredentialLeakCase[] = [
  leak(
    'Authorization: Basic header',
    'dXNlcjpwYXNzd29yZDEyMw==',
    (s) => `Authorization: Basic ${s}`
  ),
  leak(
    'lowercase proxy-authorization Basic',
    'Zm9vOmJhcmJhemJheg==',
    (s) => `proxy-authorization: basic ${s}`
  ),
  leak(
    'Authorization: token header',
    `abc${alnum(20)}`,
    (s) => `request failed (Authorization: token ${s})`
  ),
  leak(
    'access_token query parameter',
    `at${alnum(18)}`,
    (s) => `GET https://api.example.com/v1?access_token=${s}&page=2`
  ),
  leak(
    'client_secret form field',
    `cs${alnum(18)}`,
    (s) => `grant_type=refresh&client_secret=${s}`
  ),
  leak('JSON refresh_token', `rt${alnum(18)}`, (s) => `{"refresh_token":"${s}","expires_in":3600}`),
  leak('JSON private_token', `pt${alnum(18)}`, (s) => `{"private_token": "${s}"}`),
  leak('GitLab PAT', `glpat-${alnum(20)}`, (s) => `remote rejected ${s}`),
  leak(
    'GitHub fine-grained PAT',
    `github_pat_11${alnum(20)}_${alnum(40)}`,
    (s) => `using ${s} now`
  ),
  leak('GitHub OAuth token', `gho_${alnum(36)}`, (s) => `gh token ${s}`),
  leak('GitHub server token', `ghs_${alnum(36)}`, (s) => `gh token ${s}`),
  leak('GitHub user-to-server token', `ghu_${alnum(36)}`, (s) => `gh token ${s}`),
  leak('Linear API key', `lin_api_${alnum(40)}`, (s) => `linear says ${s} is invalid`),
  leak('npm token', `npm_${alnum(36)}`, (s) => `//registry.npmjs.org/:_authToken ${s}`),
  leak('Google API key', `AIza${alnum(35)}`, (s) => `maps key ${s} rejected`),
  leak('Slack bot token', `xoxb-${alnum(12)}-${alnum(24)}`, (s) => `slack ${s}`),
  leak('Slack app token', `xoxa-${alnum(12)}-${alnum(24)}`, (s) => `slack ${s}`),
  leak('Slack user token', `xoxp-${alnum(12)}-${alnum(24)}`, (s) => `slack ${s}`),
  leak('Anthropic key', `sk-ant-api03-${alnum(40)}`, (s) => `claude ${s}`),
  leak('OpenAI key', `sk-${alnum(40)}`, (s) => `openai ${s}`),
  leak('Cookie header', `sess${alnum(16)}`, (s) => `Cookie: session=${s}; theme=dark`),
  leak('Cookie header second cookie', `csrf${alnum(16)}`, (s) => `cookie: a=1; csrftoken=${s}`),
  leak('Set-Cookie header', `sid${alnum(16)}`, (s) => `set-cookie: sid=${s}; Path=/; HttpOnly`)
]

/** Ordinary diagnostic text that must pass through unchanged. */
export const BENIGN_TEXTS: readonly string[] = [
  'Failed to set cookie: domain mismatch',
  'cookie jar cleared after logout',
  'token count exceeded the context window',
  'the authorization flow completed successfully',
  'Basic usage: run orca --help',
  'Using a task-runner-for-the-monorepo-build pipeline',
  'risk-assessment-matrix-for-the-quarterly-review',
  'npm_config_cache is set by the shell',
  'AIzawa is a surname',
  'lin_api_docs reference page',
  'git checkout main && git pull --ff-only',
  'expected 3 tokens but received 4',
  'secret santa list updated'
]
