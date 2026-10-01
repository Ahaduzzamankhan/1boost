import { useEffect } from 'react'

/**
 * The custom CSS layer.
 *
 * Users can restyle 1Boost by pasting their own CSS. That is a powerful knob,
 * so it is deliberately constrained:
 *
 * * It lives in **one** dedicated `<style>` element, injected after the app's
 *   own stylesheets. Nothing else in the app is aware of it, so clearing the
 *   preference restores the default UI completely — there is no partially
 *   applied state to recover from.
 * * Remote loads are stripped (`@import`, external `url()`, `behavior`,
 *   `-moz-binding`). A stylesheet that could fetch or execute would turn a
 *   cosmetic feature into a network and security surface, which is not what
 *   anyone asking for a font colour wants.
 * * Custom CSS may not target the layer itself, so a rule cannot delete the
 *   element that holds it and leave the app unstyled.
 * * Nor may it hide the application: `body { display: none }` would remove the
 *   only editor that could undo it. Ordinary parts of the UI (a card, the
 *   sidebar) can still be hidden — only the containers are protected.
 * * Even a pathological stylesheet can only restyle things. It cannot add
 *   behaviour: there is no scripting path from CSS to the app's state, and the
 *   palette/editor keep their own keyboard handling regardless of how the UI
 *   looks.
 *
 * The documented variables live in `src/index.css`; see README for the list.
 */

/** The style element every customization lands in. */
const STYLE_ID = '1boost-custom-css'

/**
 * Matches the constructs that could load or run something.
 *
 * `url(...)` is matched through to its closing paren: stripping only the
 * opening left the URL itself in the stylesheet, which still leaked the
 * request. An inline `data:image` is allowed because it cannot reach the
 * network, which is what makes custom icons and background images usable.
 */
const UNSAFE = [
  /@import\b[^;]*;?/gi,
  /@charset\b[^;]*;?/gi,
  /@namespace\b[^;]*;?/gi,
  /\bbehavior\s*:/gi,
  /-moz-binding\s*:/gi,
  /expression\s*\([^)]*\)?/gi,
  /(?:javascript|vbscript)\s*:/gi,
  /url\s*\(\s*(?!['"]?data:image\/)[^)]*\)/gi,
]

/**
 * Rules that would let a stylesheet dismantle its own container. Rather than
 * trying to enumerate what a "safe" selector looks like, the layer simply
 * refuses to be targeted.
 */
const PROTECTED = new Set([STYLE_ID, 'oneboost-custom-css'])

/**
 * Selectors that mean "the whole application", and the declarations that
 * would leave nothing on screen if they were allowed through.
 *
 * `body { display: none }` is not a style choice, it is a way to lose the
 * window: the Settings editor that could undo it lives inside the thing being
 * hidden. These are only refused on the containers themselves — hiding one
 * card, or even the whole sidebar, is a legitimate thing to want.
 */
const ROOT_SELECTORS = /(^|,)\s*(html|body|:root|#root|\.app)\s*(,|$)/

const BLINDING: { pattern: RegExp; neutral: string }[] = [
  { pattern: /display\s*:\s*none\s*(?=;|})/gi, neutral: 'display:revert' },
  { pattern: /visibility\s*:\s*hidden\s*(?=;|})/gi, neutral: 'visibility:visible' },
  { pattern: /opacity\s*:\s*0(?:\.0+)?\s*(?=;|})/gi, neutral: 'opacity:1' },
]

/** Applies `css` to the document, or clears the layer when it is empty. */
export function applyCustomCss(css: string): void {
  const doc = typeof document === 'undefined' ? null : document
  if (!doc) return
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!css.trim()) {
    el?.remove()
    return
  }
  if (!el) {
    el = doc.createElement('style')
    el.id = STYLE_ID
    // Injected last so a customization wins over the app's own rules without
    // needing !important everywhere.
    doc.head.appendChild(el)
  }
  el.textContent = sanitizeCss(css)
}

/**
 * Strips the constructs that could load or execute something, and refuses any
 * rule that targets the layer's own element.
 *
 * Exported for the test suite: sanitizing is the whole safety story for this
 * feature, so it is pinned rather than trusted.
 */
export function sanitizeCss(css: string): string {
  let out = css
  for (const pattern of UNSAFE) out = out.replace(pattern, '/* removed */')
  out = out
    // A customization is for looks, so a declaration that could take over the
    // window chrome is dropped rather than allowed to sit over the shell.
    .replace(/position\s*:\s*fixed\s*(?=;|})/gi, 'position:static')
    .replace(/<\/?\s*script/gi, '')
    .replace(/<\/?\s*style/gi, '')
  return guardSelectors(out)
}

/**
 * Removes any selector list that mentions the style element's own id, and
 * softens declarations that would hide the application itself.
 *
 * Cheap and conservative: one bad rule in a block drops the whole block, which
 * is acceptable because the alternative is silently allowing it.
 */
function guardSelectors(css: string): string {
  const out: string[] = []
  let index = 0
  while (index < css.length) {
    const braceAt = css.indexOf('{', index)
    if (braceAt === -1) {
      out.push(css.slice(index))
      break
    }
    const prelude = css.slice(index, braceAt)
    const end = matchBrace(css, braceAt)
    if (end === -1) {
      out.push(css.slice(index))
      break
    }
    const body = css.slice(braceAt, end + 1)
    const mentions = [...PROTECTED].some((id) => prelude.includes(id))
    if (mentions) {
      out.push('/* selector removed */')
    } else {
      // Only the innermost selector list decides: `body { } .card { }` must
      // keep the card rule.
      const subject = prelude.slice(prelude.lastIndexOf('}') + 1).trim()
      out.push(subject && ROOT_SELECTORS.test(subject) ? soften(prelude, body) : prelude + body)
    }
    index = end + 1
  }
  return out.join('')
}

/**
 * Replaces the declarations that could blank the window, keeping the rest of
 * the rule. Each one is swapped for its own neutral value rather than being
 * deleted, so the surrounding rule still parses and the stylesheet stays
 * valid. Settings already reports that something was changed.
 */
function soften(prelude: string, body: string): string {
  // The closing brace stays in: the patterns end on `;` or `}`, and the last
  // declaration in a rule usually has no semicolon.
  let out = body
  for (const { pattern, neutral } of BLINDING) out = out.replace(pattern, neutral)
  return prelude + out
}

/** Index of the `}` closing the `{` at `open`, or -1 when unbalanced. */
function matchBrace(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Applies the user's stylesheet whenever it changes, and removes the layer on
 * unmount so a hot reload cannot leave an orphan stylesheet behind.
 */
export function useCustomCss(css: string): void {
  useEffect(() => {
    applyCustomCss(css)
  }, [css])
}

/**
 * The variables a customization is expected to use. Shown in Settings so the
 * feature is discoverable without shipping a separate manual.
 */
export const CUSTOM_CSS_VARIABLES: { name: string; group: string }[] = [
  { name: '--bg', group: 'Surface' },
  { name: '--surface', group: 'Surface' },
  { name: '--surface-hover', group: 'Surface' },
  { name: '--border', group: 'Surface' },
  { name: '--border-strong', group: 'Surface' },
  { name: '--text-primary', group: 'Text' },
  { name: '--text-secondary', group: 'Text' },
  { name: '--text-muted', group: 'Text' },
  { name: '--accent', group: 'Accent' },
  { name: '--accent-strong', group: 'Accent' },
  { name: '--accent-soft', group: 'Accent' },
  { name: '--accent-text', group: 'Accent' },
  { name: '--radius-sm', group: 'Shape' },
  { name: '--radius-md', group: 'Shape' },
  { name: '--radius-lg', group: 'Shape' },
  { name: '--radius-xl', group: 'Shape' },
  { name: '--space-1', group: 'Spacing' },
  { name: '--space-2', group: 'Spacing' },
  { name: '--space-3', group: 'Spacing' },
  { name: '--space-4', group: 'Spacing' },
  { name: '--space-5', group: 'Spacing' },
  { name: '--space-6', group: 'Spacing' },
  { name: '--space-8', group: 'Spacing' },
  { name: '--space-10', group: 'Spacing' },
  { name: '--text-page-title', group: 'Type' },
  { name: '--text-section', group: 'Type' },
  { name: '--text-value', group: 'Type' },
  { name: '--text-body', group: 'Type' },
  { name: '--text-secondary-size', group: 'Type' },
  { name: '--text-muted-size', group: 'Type' },
  { name: '--font', group: 'Type' },
  { name: '--shadow-card', group: 'Depth' },
  { name: '--shadow-pop', group: 'Depth' },
  { name: '--transition-fast', group: 'Motion' },
  { name: '--transition-normal', group: 'Motion' },
  { name: '--transition-slow', group: 'Motion' },
  { name: '--ease', group: 'Motion' },
]

/** Component hooks worth mentioning, so the CSS is usable without source. */
export const CUSTOM_CSS_SELECTORS: { selector: string; what: string }[] = [
  { selector: '.sidebar', what: 'the left navigation rail' },
  { selector: '.nav-item', what: 'one sidebar entry' },
  { selector: '.content', what: 'the main content area' },
  { selector: '.page', what: 'a module page' },
  { selector: '.page-header', what: 'the heading block of a page' },
  { selector: '.card', what: 'a card surface' },
  { selector: '.btn', what: 'any button' },
  { selector: '.btn-primary', what: 'the primary button' },
  { selector: '.chip', what: 'a small inline chip' },
  { selector: '.segmented', what: 'a segmented control' },
  { selector: '.empty-state', what: 'an empty / placeholder state' },
  { selector: '.search-row', what: 'one row of search results' },
  { selector: '.palette', what: 'the command center overlay' },
  { selector: '.palette-row', what: 'one row of the command center' },
  { selector: '.editor', what: 'the block editor surface' },
  { selector: '.block', what: 'one block in the editor' },
  { selector: '.task-row', what: 'one row in a task list' },
  { selector: '.board-column', what: 'one column of the task board' },
  { selector: '.tree-row', what: 'one row in the page tree' },
]