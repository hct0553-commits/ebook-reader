// 閱讀畫面：FlowView（一次顯示一章，捲動閱讀）與 PdfView（連續頁面、延遲繪製）
import { applyHighlights } from './highlights.js'

const DROP = new Set(['script', 'style', 'link', 'meta', 'title', 'iframe', 'object', 'embed',
    'form', 'input', 'button', 'textarea', 'select', 'noscript', 'base', 'head', 'frame', 'frameset'])

function sanitizeInto(target, srcBody) {
    const body = document.importNode(srcBody, true)
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_CDATA_SECTION)
    const remove = [], cdata = []
    let n
    while ((n = walker.nextNode())) {
        if (n.nodeType === Node.CDATA_SECTION_NODE) { cdata.push(n); continue }
        const tag = n.localName?.toLowerCase()
        if (DROP.has(tag)) { remove.push(n); continue }
        for (const attr of [...n.attributes]) {
            const name = attr.name.toLowerCase()
            if (name.startsWith('on') || name === 'style' ||
                ((name === 'href' || name.endsWith(':href') || name === 'src') && /^\s*javascript:/i.test(attr.value)))
                n.removeAttribute(attr.name)
        }
    }
    remove.forEach(el => el.remove())
    cdata.forEach(c => c.replaceWith(document.createTextNode(c.data)))
    target.replaceChildren(...body.childNodes)
}

const throttle = (fn, ms) => {
    let t = 0, timer
    return (...args) => {
        const now = Date.now()
        clearTimeout(timer)
        if (now - t > ms) { t = now; fn(...args) }
        else timer = setTimeout(() => { t = Date.now(); fn(...args) }, ms)
    }
}

/* ========================= Flow ========================= */
export class FlowView {
    constructor({ scroll, content, book, getHighlights, onRelocate, onLink }) {
        Object.assign(this, { scroll, content, book, getHighlights, onRelocate, onLink })
        this.index = -1
        this.root = null
        const sizes = book.sections.map(s => s.size)
        this.total = sizes.reduce((a, b) => a + b, 0) || 1
        this.before = sizes.map((_, i) => sizes.slice(0, i).reduce((a, b) => a + b, 0))
        this.onScroll = throttle(() => this.onRelocate?.(this.position()), 400)
        scroll.addEventListener('scroll', this.onScroll, { passive: true })
        this.onClick = e => {
            const a = e.target.closest?.('a[href]')
            if (!a || !this.root?.contains(a)) return
            e.preventDefault()
            this.onLink?.(a.getAttribute('href'), this.index)
        }
        content.addEventListener('click', this.onClick)
        content.classList.remove('pdf')
    }
    get count() { return this.book.sections.length }

    async show(index, { frac = 0, anchor = null, highlightId = null } = {}) {
        index = Math.max(0, Math.min(this.count - 1, index))
        const { body } = await this.book.sections[index].render()
        const root = document.createElement('div')
        root.className = 'flow' + (this.book.format === 'txt' ? ' txt' : '')
        sanitizeInto(root, body)
        const end = document.createElement('div')
        end.className = 'section-end'
        end.textContent = index < this.count - 1 ? '— 本章結束，點下方「下一章」繼續 —' : '— 全書完 —'
        this.content.replaceChildren(root, end)
        this.root = root
        this.index = index
        applyHighlights(root, this.getHighlights(index))

        const place = () => {
            if (highlightId) {
                const m = root.querySelector(`mark.hl[data-id="${CSS.escape(highlightId)}"]`)
                if (m) { m.scrollIntoView({ block: 'center' }); flash(root, highlightId); return }
            }
            if (anchor) {
                const el = typeof anchor === 'function' ? anchor(document) : document.getElementById(anchor)
                if (el && el.nodeType === 1) { el.scrollIntoView({ block: 'start' }); return }
            }
            const max = this.scroll.scrollHeight - this.scroll.clientHeight
            this.scroll.scrollTop = frac * Math.max(0, max)
        }
        place()
        // 圖片載入後高度會變，再對位一次
        const imgs = [...root.querySelectorAll('img')].filter(i => !i.complete)
        if (imgs.length && (frac || anchor || highlightId)) {
            await Promise.race([
                Promise.all(imgs.map(i => new Promise(r => { i.onload = i.onerror = r }))),
                new Promise(r => setTimeout(r, 1500)),
            ])
            place()
        }
        this.onRelocate?.(this.position())
    }
    position() {
        const max = this.scroll.scrollHeight - this.scroll.clientHeight
        const frac = max > 0 ? Math.min(1, this.scroll.scrollTop / max) : 0
        const size = this.book.sections[this.index]?.size ?? 0
        return { section: this.index, frac, percent: (this.before[this.index] + frac * size) / this.total }
    }
    rootFor(node) {
        return this.root?.contains(node) ? { section: this.index, root: this.root } : null
    }
    rootsForSection(section) { return section === this.index && this.root ? [this.root] : [] }
    relayout() { /* 字體變更由 CSS 處理 */ }
    destroy() {
        this.scroll.removeEventListener('scroll', this.onScroll)
        this.content.removeEventListener('click', this.onClick)
    }
}

export function flash(root, id) {
    const marks = root.querySelectorAll(`mark.hl[data-id="${CSS.escape(id)}"]`)
    marks.forEach(m => { m.classList.remove('flash'); void m.offsetWidth; m.classList.add('flash') })
}

/* ========================= PDF ========================= */
export class PdfView {
    constructor({ scroll, content, book, getHighlights, onRelocate }) {
        Object.assign(this, { scroll, content, book, getHighlights, onRelocate })
        this.zoom = 1
        this.pages = []          // { div, ratio, state: 0 空 / 1 繪製中 / 2 完成, textLayer, task }
        this.index = 0
        content.classList.add('pdf')
        this.onScroll = throttle(() => {
            this.index = this.currentPage()
            this.onRelocate?.(this.position())
        }, 300)
        scroll.addEventListener('scroll', this.onScroll, { passive: true })
        this.onResize = throttle(() => this.relayout(), 300)
        window.addEventListener('resize', this.onResize)
    }
    get count() { return this.book.numPages }

    async init() {
        const first = await this.book.pdf.getPage(1)
        const vp = first.getViewport({ scale: 1 })
        const ratio = vp.height / vp.width
        const frag = document.createDocumentFragment()
        for (let i = 0; i < this.count; i++) {
            const div = document.createElement('div')
            div.className = 'pdf-page'
            div.dataset.index = i
            const num = document.createElement('span')
            num.className = 'page-num'
            num.textContent = `${i + 1} / ${this.count}`
            div.append(num)
            frag.append(div)
            this.pages.push({ div, ratio, state: 0 })
        }
        this.content.replaceChildren(frag)
        this.layout()
        this.observer = new IntersectionObserver(entries => {
            for (const e of entries) {
                const i = +e.target.dataset.index
                if (e.isIntersecting) this.renderPage(i)
                else this.clearPage(i)
            }
        }, { root: this.scroll, rootMargin: '1200px 0px' })
        this.pages.forEach(p => this.observer.observe(p.div))
    }
    pageWidth() {
        return Math.round(Math.min(this.scroll.clientWidth - 16, 980) * this.zoom)
    }
    layout() {
        const w = this.pageWidth()
        for (const p of this.pages) {
            p.div.style.width = w + 'px'
            p.div.style.height = Math.round(w * p.ratio) + 'px'
        }
    }
    relayout() {
        const pos = this.position()
        this.layout()
        this.pages.forEach((_, i) => this.clearPage(i))
        this.scrollToPage(pos.section, pos.pageFrac)
        // IntersectionObserver 不一定會重新觸發，手動重繪可見頁
        requestAnimationFrame(() => this.visiblePages().forEach(i => this.renderPage(i)))
    }
    visiblePages() {
        const top = this.scroll.scrollTop - 1200, bottom = this.scroll.scrollTop + this.scroll.clientHeight + 1200
        return this.pages.map((p, i) => [p, i]).filter(([p]) => {
            const t = p.div.offsetTop, b = t + p.div.offsetHeight
            return b > top && t < bottom
        }).map(([, i]) => i)
    }
    setZoom(z) {
        this.zoom = Math.max(0.5, Math.min(3, z))
        this.relayout()
    }
    async renderPage(i) {
        const p = this.pages[i]
        if (!p || p.state) return
        p.state = 1
        const token = p.token = Symbol()
        try {
            const page = await this.book.pdf.getPage(i + 1)
            if (p.token !== token) return
            const vp1 = page.getViewport({ scale: 1 })
            const ratio = vp1.height / vp1.width
            if (Math.abs(ratio - p.ratio) > 0.001) {
                const oldH = p.div.offsetHeight, above = p.div.offsetTop < this.scroll.scrollTop
                p.ratio = ratio
                p.div.style.height = Math.round(this.pageWidth() * ratio) + 'px'
                if (above) this.scroll.scrollTop += p.div.offsetHeight - oldH
            }
            const cssW = this.pageWidth()
            const scale = cssW / vp1.width
            const dpr = Math.min(window.devicePixelRatio || 1, 2)
            const viewport = page.getViewport({ scale: scale * dpr })
            const canvas = document.createElement('canvas')
            canvas.width = Math.floor(viewport.width)
            canvas.height = Math.floor(viewport.height)
            p.task = page.render({ canvasContext: canvas.getContext('2d'), viewport })
            await p.task.promise
            if (p.token !== token) return

            const tl = document.createElement('div')
            tl.className = 'textLayer'
            p.div.style.setProperty('--scale-factor', scale)
            p.div.style.setProperty('--total-scale-factor', scale)
            p.div.style.setProperty('--user-unit', 1)
            const textLayer = new this.book.lib.TextLayer({
                textContentSource: page.streamTextContent(),
                container: tl,
                viewport: page.getViewport({ scale }),
            })
            await textLayer.render()
            if (p.token !== token) return
            p.div.querySelectorAll('canvas, .textLayer').forEach(el => el.remove())
            p.div.prepend(canvas)
            p.div.append(tl)
            p.textLayer = tl
            applyHighlights(tl, this.getHighlights(i))
            p.state = 2
            for (const c of document.querySelectorAll('.hiddenCanvasElement')) c.style.display = 'none'
        } catch (e) {
            if (p.token === token) p.state = 0
            if (e?.name !== 'RenderingCancelledException') console.warn('PDF 頁面繪製失敗', i + 1, e)
        }
    }
    clearPage(i) {
        const p = this.pages[i]
        if (!p || !p.state) return
        p.token = null
        try { p.task?.cancel() } catch { /* ignore */ }
        p.div.querySelectorAll('canvas, .textLayer').forEach(el => el.remove())
        p.textLayer = null
        p.state = 0
    }
    currentPage() {
        const y = this.scroll.scrollTop + this.scroll.clientHeight * 0.3
        let lo = 0, hi = this.pages.length - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (this.pages[mid].div.offsetTop <= y) lo = mid
            else hi = mid - 1
        }
        return lo
    }
    scrollToPage(i, frac = 0) {
        const p = this.pages[Math.max(0, Math.min(this.count - 1, i))]
        if (!p) return
        this.scroll.scrollTop = p.div.offsetTop - 8 + frac * p.div.offsetHeight
    }
    async show(index, { frac = 0, highlightId = null } = {}) {
        this.scrollToPage(index, frac)
        this.index = Math.max(0, Math.min(this.count - 1, index))
        if (highlightId) {
            await this.renderPage(this.index)
            const tl = this.pages[this.index].textLayer
            const m = tl?.querySelector(`mark.hl[data-id="${CSS.escape(highlightId)}"]`)
            if (m) { m.scrollIntoView({ block: 'center' }); flash(tl, highlightId) }
        }
        this.onRelocate?.(this.position())
    }
    position() {
        const i = this.currentPage()
        const p = this.pages[i]
        const pageFrac = p ? Math.max(0, (this.scroll.scrollTop - p.div.offsetTop + 8) / p.div.offsetHeight) : 0
        return { section: i, frac: Math.min(1, pageFrac), pageFrac: Math.min(1, pageFrac), percent: (i + 1) / this.count }
    }
    rootFor(node) {
        const div = (node.nodeType === 1 ? node : node.parentElement)?.closest?.('.pdf-page')
        if (!div) return null
        const i = +div.dataset.index
        const tl = this.pages[i]?.textLayer
        return tl && tl.contains(node) ? { section: i, root: tl } : null
    }
    rootsForSection(section) {
        const tl = this.pages[section]?.textLayer
        return tl ? [tl] : []
    }
    destroy() {
        this.observer?.disconnect()
        this.pages.forEach((_, i) => this.clearPage(i))
        this.scroll.removeEventListener('scroll', this.onScroll)
        window.removeEventListener('resize', this.onResize)
        this.content.classList.remove('pdf')
    }
}
