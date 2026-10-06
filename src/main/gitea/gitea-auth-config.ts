export type GiteaAuthConfig = {
  apiBaseUrl: string | null
  token: string | null
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function normalizeGiteaApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

export function getGiteaAuthConfig(): GiteaAuthConfig {
  const apiBaseUrl = envValue('ORCA_GITEA_API_BASE_URL')
  return {
    apiBaseUrl: apiBaseUrl ? normalizeGiteaApiBaseUrl(apiBaseUrl) : null,
    token: envValue('ORCA_GITEA_TOKEN')
  }
}

function urlOrigin(value: string | URL): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

/** True when the token may be sent to `requestUrl`: only the configured server's exact origin. */
export function isGiteaTokenAllowedForUrl(
  requestUrl: string | URL,
  config: GiteaAuthConfig = getGiteaAuthConfig()
): boolean {
  // Why: Gitea is the catch-all forge, so a remote-derived API host can be any
  // server the git remote names. Comparing full origins also keeps the token off
  // plain http unless the user configured an http base URL themselves.
  if (!config.token || !config.apiBaseUrl) {
    return false
  }
  const allowedOrigin = urlOrigin(config.apiBaseUrl)
  return allowedOrigin !== null && urlOrigin(requestUrl) === allowedOrigin
}

export function giteaAuthHeadersForUrl(
  requestUrl: string | URL,
  config: GiteaAuthConfig = getGiteaAuthConfig()
): Record<string, string> {
  return isGiteaTokenAllowedForUrl(requestUrl, config)
    ? { Authorization: `token ${config.token}` }
    : {}
}

/** A token without a base URL is never sent, so it cannot authenticate anything. */
export function isGiteaTokenUsable(config: GiteaAuthConfig = getGiteaAuthConfig()): boolean {
  return config.token !== null && config.apiBaseUrl !== null
}
