// 各種電子書格式 → 統一的書籍物件
//   flow 類（EPUB / MOBI / AZW3 / FB2 / CBZ / TXT / DOCX）：
//     { kind:'flow', format, metadata, sections:[{size, render()}], toc, resolveLink(), getCover() }
//   pdf：
//     { kind:'pdf', format:'pdf', metadata, pdf, lib, numPages, toc, getCover() }

const PDFJS_BASE = new URL('../vendor/foliate-js/vendor/pdfjs/', import.meta.url).href

export const SUPPORTED = ['epub', 'pdf', 'mobi', 'azw3', 'azw', 'prc', 'txt', 'docx', 'fb2', 'fbz', 'cbz']

export const detectFormat = name => {
    const n = name.toLowerCase()
    if (n.endsWith('.fb2.zip')) return 'fbz'
    const ext = n.split('.').pop()
    return SUPPORTED.includes(ext) ? ext : null
}

export const stripExt = name => name.replace(/\.fb2\.zip$/i, '').replace(/\.[^.]+$/, '')

const langText = x => typeof x === 'string' ? x
    : x && typeof x === 'object' ? (x.zh ?? x['zh-TW'] ?? Object.values(x)[0] ?? '') : ''
const contribText = x => Array.isArray(x) ? x.map(contribText).filter(Boolean).join('、')
    : typeof x === 'string' ? x
    : x?.name ? langText(x.name) : langText(x)

const escapeHTML = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export async function openBook(file, format) {
    switch (format) {
        case 'pdf': return openPDF(file)
        case 'txt': return openTXT(file)
        case 'docx': return openDOCX(file)
        default: return openFoliate(file, format)
    }
}

/* ---------------- EPUB / MOBI / AZW3 / FB2 / CBZ（使用 foliate-js 解析） ---------------- */
async function openFoliate(file, format) {
    const { makeBook } = await import('../vendor/foliate-js/view.js')
    const book = await makeBook(file)
    const sections = book.sections.map(s => ({
        size: s.size || 1,
        resolveHref: s.resolveHref,
        async render() {
            const url = await s.load()
            const res = await fetch(url)
            let type = (res.headers.get('content-type') || '').split(';')[0].trim()
            const text = await res.text()
            if (!['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml'].includes(type))
                type = /^\s*<\?xml|xmlns=/.test(text) ? 'application/xhtml+xml' : 'text/html'
            let doc = new DOMParser().parseFromString(text, type)
            if (doc.querySelector('parsererror') || !doc.body)
                doc = new DOMParser().parseFromString(text, 'text/html')
            return { body: doc.body ?? doc.documentElement }
        },
    }))

    const toc = []
    const walk = async (items, depth) => {
        for (const item of items ?? []) {
            let section = -1, anchor = null
            try {
                const r = await book.resolveHref(item.href)
                if (r) { section = r.index; anchor = r.anchor }
            } catch { /* 無法解析的目錄項目 */ }
            toc.push({ label: (langText(item.label) || '').trim() || '(無標題)', section, anchor, depth })
            await walk(item.subitems, depth + 1)
        }
    }
    await walk(book.toc, 0)

    return {
        kind: 'flow', format, sections, toc,
        metadata: {
            title: langText(book.metadata?.title) || stripExt(file.name),
            author: contribText(book.metadata?.author),
        },
        async resolveLink(href, sectionIndex) {
            const s = book.sections[sectionIndex]
            const full = s?.resolveHref ? s.resolveHref(href) : href
            if (book.isExternal?.(full)) return { external: full }
            const r = await book.resolveHref(full)
            return r ? { section: r.index, anchor: r.anchor } : null
        },
        getCover: () => book.getCover?.().catch(() => null) ?? null,
        destroy: () => book.destroy?.(),
    }
}

/* ---------------- TXT ---------------- */
const COMMON_TC = '的一是不了人我在有他這中大來上個們到說時要就出會也你對生能而子那得於著下自之年過發後作裡用道行所然家種事成方多經麼去法學如都同現當沒動面起看定天分還進好小部其些主樣理心她本前開但因只從想實'
const COMMON_SC = '的一是不了人我在有他这中大来上个们到说时要就出会也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实'

export function decodeText(bytes) {
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return new TextDecoder('utf-8').decode(bytes.subarray(3))
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* 不是 UTF-8 */ }
    // 繁體 Big5 與簡體 GB18030 擇一：取亂碼最少、常用字最多者
    const sample = bytes.subarray(0, 200000)
    const score = (enc, common) => {
        const s = new TextDecoder(enc).decode(sample)
        let sc = 0
        for (const ch of s) {
            if (ch === '�') sc -= 20
            else if (common.includes(ch)) sc += 1
        }
        return sc
    }
    const enc = score('big5', COMMON_TC) >= score('gb18030', COMMON_SC) ? 'big5' : 'gb18030'
    return new TextDecoder(enc).decode(bytes)
}

const CHAPTER_RE = /^[ \t　]*(第[0-9０-９〇零一二三四五六七八九十百千萬万两兩]+[章回節节卷集部篇話话幕]|序章|序言|序|楔子|引子|前言|後記|后记|尾聲|尾声|番外[^\n]{0,20}|終章|终章|Chapter\s*\d+|CHAPTER\s*\d+|Prologue|Epilogue)([ \t　:：、.．][^\n]{0,40})?[ \t　]*$/gm

async function openTXT(file) {
    const text = decodeText(new Uint8Array(await file.arrayBuffer())).replace(/\r\n?/g, '\n')
    const parts = []
    const matches = [...text.matchAll(CHAPTER_RE)]
    if (matches.length >= 2) {
        const head = text.slice(0, matches[0].index)
        if (head.trim()) parts.push({ title: '開始', body: head })
        matches.forEach((m, i) => {
            const end = i + 1 < matches.length ? matches[i + 1].index : text.length
            parts.push({ title: m[0].trim(), body: text.slice(m.index + m[0].length, end), heading: true })
        })
    } else {
        // 沒有章節標記：每約 15,000 字切一段
        const CHUNK = 15000
        let pos = 0, n = 1
        while (pos < text.length) {
            let end = Math.min(text.length, pos + CHUNK)
            if (end < text.length) {
                const nl = text.indexOf('\n', end)
                end = nl === -1 ? text.length : nl + 1
            }
            parts.push({ title: `第 ${n++} 部分`, body: text.slice(pos, end) })
            pos = end
        }
        if (!parts.length) parts.push({ title: '全文', body: '' })
    }
    const sections = parts.map(p => ({
        size: p.body.length || 1,
        title: p.title,
        async render() {
            const html = (p.heading ? `<h2>${escapeHTML(p.title)}</h2>` : '') +
                p.body.split('\n').map(l => l.trim()).filter(Boolean)
                    .map(l => `<p>${escapeHTML(l)}</p>`).join('')
            const body = document.createElement('div')
            body.innerHTML = html
            return { body }
        },
    }))
    return {
        kind: 'flow', format: 'txt', sections,
        toc: parts.map((p, i) => ({ label: p.title, section: i, anchor: null, depth: 0 })),
        metadata: { title: stripExt(file.name), author: '' },
        resolveLink: async () => null,
        getCover: async () => null,
    }
}

/* ---------------- DOCX（使用 mammoth.js 轉成 HTML） ---------------- */
async function openDOCX(file) {
    if (!globalThis.mammoth) throw new Error('DOCX 轉換元件尚未載入')
    const { value: html } = await globalThis.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
    const nodes = [...doc.body.childNodes]
    const parts = []
    let cur = null
    const h1count = doc.body.querySelectorAll(':scope > h1').length
    for (const node of nodes) {
        if (h1count >= 2 && node.nodeName === 'H1') {
            cur = { title: node.textContent.trim() || '(無標題)', nodes: [node] }
            parts.push(cur)
        } else {
            if (!cur) { cur = { title: '開始', nodes: [] }; parts.push(cur) }
            cur.nodes.push(node)
        }
    }
    if (!parts.length) parts.push({ title: '全文', nodes: [] })
    const sections = parts.map(p => {
        const htmlStr = p.nodes.map(n => n.outerHTML ?? escapeHTML(n.textContent)).join('')
        return {
            size: htmlStr.length || 1,
            title: p.title,
            async render() {
                const body = document.createElement('div')
                body.innerHTML = htmlStr
                return { body }
            },
        }
    })
    // 目錄：章（h1）+ 節（h2）
    const toc = []
    parts.forEach((p, i) => {
        toc.push({ label: p.title, section: i, anchor: null, depth: 0 })
        p.nodes.filter(n => n.nodeName === 'H2').forEach((h, k) => {
            const text = h.textContent.trim()
            toc.push({ label: text, section: i, anchor: () => document.querySelectorAll('.flow h2')[k], depth: 1 })
        })
    })
    return {
        kind: 'flow', format: 'docx', sections, toc,
        metadata: { title: stripExt(file.name), author: '' },
        resolveLink: async () => null,
        getCover: async () => null,
    }
}

/* ---------------- PDF（使用 pdf.js） ---------------- */
let pdfLibPromise
export const loadPdfLib = () => pdfLibPromise ??= (async () => {
    await import('../vendor/foliate-js/vendor/pdfjs/pdf.mjs')
    const lib = globalThis.pdfjsLib
    lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.mjs'
    return lib
})()

async function openPDF(file) {
    const lib = await loadPdfLib()
    const pdf = await lib.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        cMapUrl: PDFJS_BASE + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
        isEvalSupported: false,
    }).promise
    let info = {}
    try { info = (await pdf.getMetadata()).info ?? {} } catch { /* 無中繼資料 */ }

    const toc = []
    try {
        const outline = await pdf.getOutline()
        const walk = async (items, depth) => {
            for (const it of items ?? []) {
                let section = -1
                try {
                    const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest
                    if (dest?.[0]) section = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0])
                } catch { /* 無法解析 */ }
                toc.push({ label: it.title || '(無標題)', section, anchor: null, depth })
                await walk(it.items, depth + 1)
            }
        }
        await walk(outline, 0)
    } catch { /* 無目錄 */ }

    return {
        kind: 'pdf', format: 'pdf', pdf, lib, numPages: pdf.numPages, toc,
        metadata: { title: (info.Title || '').trim() || stripExt(file.name), author: (info.Author || '').trim() },
        async getCover() {
            const page = await pdf.getPage(1)
            const vp1 = page.getViewport({ scale: 1 })
            const viewport = page.getViewport({ scale: 300 / vp1.width })
            const canvas = document.createElement('canvas')
            canvas.width = viewport.width; canvas.height = viewport.height
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
            return new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8))
        },
        destroy: () => pdf.destroy(),
    }
}

/* 封面縮圖：縮到 300px 寬的 JPEG */
export async function makeThumb(blob) {
    if (!blob) return null
    try {
        const bmp = await createImageBitmap(blob)
        const w = 300, h = Math.round(bmp.height * (w / bmp.width))
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(bmp, 0, 0, w, h)
        return await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82))
    } catch { return null }
}
