// Tiny DOM helpers shared by the two windows. Text is always set as text, never as HTML.
window.UI = (() => {
  const ICONS = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 19l2.5-8.5A2 2 0 0 1 7.4 9H21l-2.5 8.5A2 2 0 0 1 16.6 19z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    chevR: '<path d="M9 6l6 6-6 6"/>',
    chevD: '<path d="M6 9l6 6 6-6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/>',
    warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
    check: '<path d="M5 12l4 4 10-10"/>',
    retry: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    swap: '<path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4"/>',
    spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5h.01"/>'
  }
  const SVGNS = 'http://www.w3.org/2000/svg'

  function ic(name, cls) {
    const svg = document.createElementNS(SVGNS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''))
    svg.setAttribute('aria-hidden', 'true')
    const t = document.createElementNS(SVGNS, 'svg')
    t.innerHTML = ICONS[name] || ''
    while (t.firstChild) svg.appendChild(t.firstChild)
    return svg
  }

  // h('div', {class:'x', onclick: fn, style:{...}, 'aria-label':'..'}, child, ...)
  function h(tag, props, ...kids) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'style') Object.assign(el.style, v)
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else if (k === 'value') el.value = v
      else if (k === 'checked') el.checked = !!v
      else if (k === 'disabled') el.disabled = !!v
      else el.setAttribute(k, v === true ? '' : v)
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === undefined || kid === null || kid === false) continue
      el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid)
    }
    return el
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el }
  function mount(el, ...kids) {
    clear(el)
    for (const k of kids.flat(Infinity)) {
      if (k === undefined || k === null || k === false) continue
      el.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k)
    }
    return el
  }

  // Re-render while keeping focus and caret in an element marked with data-fid.
  function keepFocus(fn) {
    const a = document.activeElement
    const fid = a && a.dataset && a.dataset.fid
    const start = a && a.selectionStart, end = a && a.selectionEnd
    fn()
    if (fid) {
      const n = document.querySelector('[data-fid="' + fid + '"]')
      if (n) { n.focus(); try { n.setSelectionRange(start, end) } catch { /* not a text field */ } }
    }
  }

  return { ic, h, clear, mount, keepFocus }
})()
