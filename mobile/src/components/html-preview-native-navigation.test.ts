import { describe, expect, it } from 'vitest'
import {
  MOBILE_HTML_PREVIEW_JAVASCRIPT_ENABLED,
  decideHtmlPreviewNavigation
} from './html-preview-native-navigation'

const BLOCKED = { loadInPlace: false, openExternally: null }

describe('decideHtmlPreviewNavigation', () => {
  it('loads the inline artifact in place', () => {
    expect(
      decideHtmlPreviewNavigation({ url: 'about:blank', isTopFrame: true, navigationType: 'other' })
    ).toEqual({ loadInPlace: true, openExternally: null })
    expect(
      decideHtmlPreviewNavigation({ url: 'data:text/html,<h1>hi</h1>', isTopFrame: true })
    ).toEqual({ loadInPlace: true, openExternally: null })
  })

  it('opens a tapped http(s) link externally', () => {
    expect(
      decideHtmlPreviewNavigation({
        url: 'https://example.com/docs',
        isTopFrame: true,
        navigationType: 'click'
      })
    ).toEqual({ loadInPlace: false, openExternally: 'https://example.com/docs' })
    // Android reports no navigation type; its shouldOverrideUrlLoading is the tap.
    expect(decideHtmlPreviewNavigation({ url: 'http://example.com', isTopFrame: true })).toEqual({
      loadInPlace: false,
      openExternally: 'http://example.com'
    })
  })

  it.each([
    'tel:+15555550100',
    'sms:+15555550100',
    'itms-services://?action=download-manifest&url=https://evil.example/app.plist',
    'intent://scan/#Intent;scheme=zxing;end',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'orca://pair?token=abc',
    'slack://open'
  ])('never hands %s to the OS', (url) => {
    expect(decideHtmlPreviewNavigation({ url, isTopFrame: true, navigationType: 'click' })).toEqual(
      BLOCKED
    )
    expect(decideHtmlPreviewNavigation({ url, isTopFrame: true })).toEqual(BLOCKED)
  })

  it('ignores navigations a page starts without a tap on iOS', () => {
    for (const navigationType of ['other', 'formsubmit', 'formresubmit', 'reload', 'backforward']) {
      expect(
        decideHtmlPreviewNavigation({
          url: 'https://evil.example',
          isTopFrame: true,
          navigationType
        })
      ).toEqual(BLOCKED)
    }
  })

  it('fails closed when the request is not reported as top-frame', () => {
    expect(decideHtmlPreviewNavigation({ url: 'https://example.com' })).toEqual(BLOCKED)
  })

  it('never opens or loads a subframe navigation', () => {
    expect(
      decideHtmlPreviewNavigation({
        url: 'https://evil.example/frame',
        isTopFrame: false,
        navigationType: 'click'
      })
    ).toEqual(BLOCKED)
    expect(
      decideHtmlPreviewNavigation({ url: 'https://evil.example/frame', isTopFrame: false })
    ).toEqual(BLOCKED)
  })

  it('does not navigate in place when a tap targets an inline document', () => {
    expect(
      decideHtmlPreviewNavigation({
        url: 'data:text/html,<h1>spoof</h1>',
        isTopFrame: true,
        navigationType: 'click'
      })
    ).toEqual(BLOCKED)
  })
})

describe('MOBILE_HTML_PREVIEW_JAVASCRIPT_ENABLED', () => {
  it('keeps artifact scripts off', () => {
    expect(MOBILE_HTML_PREVIEW_JAVASCRIPT_ENABLED).toBe(false)
  })
})
