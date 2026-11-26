import * as db from './db.js'
import * as drive from './drive.js'
import { openBook, detectFormat, makeThumb, SUPPORTED } from './formats.js'
import { FlowView, PdfView, flash } from './reader.js'
import {
    rangeToOffsets, textAt, wrapHighlight, unwrapHighlight, updateHighlightMarks,
    applyHighlights, newId, sortedHighlights, COLORS,
} from './highlights.js'
import * as exporter from './export.js'

const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* ====================== 狀態 ====================== */
let library = { version: 1, books: {} }
const localFiles = new Set()
const coverURLs = new Map()
let current = null   // { id, book, view, sectionTitles }
const settings = Object.assign({
    theme: 'light', fontSize: 19, lineHeight: 1.8, font: 'sans', lastColor: 'yellow',
}, JSON.parse(localStorage.getItem('settings') || '{}'))

const rec = () => current && library.books[current.id]

/* ====================== 共用 UI ====================== */
let toastTimer
function toast(msg, ms = 2600) {
    const t = $('#toast')
    t.textContent = msg
    t.classList.remove('hidden')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms)
}
function loading(text) {
    $('#loading').classList.toggle('hidden', !text)
    if (text) $('#loading-text').textContent = text
}
function openModal(title, html) {
    $('#modal-title').textContent = title
    $('#modal-body').innerHTML = html
    $('#modal').classList.remove('hidden')
    $('#modal-backdrop').classList.remove('hidden')
    return $('#modal-body')
}
function closeModal() {
    $('#modal').classList.add('hidden')
    $('#modal-backdrop').classList.add('hidden')
}
$('#modal-close').onclick = closeModal
$('#modal-backdrop').onclick = closeModal

function openDrawer(title) {
    $('#drawer-title').textContent = title
    $('#drawer').classList.add('open')
    $('#drawer-backdrop').classList.remove('hidden')
}
function closeDrawer() {
    $('#drawer').classList.remove('open')
    $('#drawer-backdrop').classList.add('hidden')
}
$('#drawer-close').onclick = closeDrawer
$('#drawer-backdrop').onclick = closeDrawer

function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`))
}

function applySettings() {
    document.body.classList.remove('theme-light', 'theme-sepia', 'theme-dark')
    document.body.classList.add(`theme-${settings.theme}`)
    const root = document.documentElement.style
    root.setProperty('--font-size', settings.fontSize + 'px')
    root.setProperty('--line-height', settings.lineHeight)
    root.setProperty('--content-font', settings.font === 'serif'
        ? '"Songti TC", "PMingLiU", "Noto Serif TC", "Source Han Serif TC", serif' : 'inherit')
    document.querySelector('meta[name=theme-color]').content =
        settings.theme === 'dark' ? '#1d2023' : settings.theme === 'sepia' ? '#efe6d2' : '#2f5d50'
    localStorage.setItem('settings', JSON.stringify(settings))
}

/* ====================== 書庫資料 ====================== */
let saveTimer
function saveLibrary({ sync = true, now = false } = {}) {
    clearTimeout(saveTimer)
    const doSave = () => db.put('kv', 'library', library).catch(e => console.error(e))
    if (now) doSave()
    else saveTimer = setTimeout(doSave, 400)
    if (sync) scheduleSync()
}

async function sha256Hex(buf) {
    if (crypto.subtle) {
        const h = await crypto.subtle.digest('SHA-256', buf)
        return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24)
    }
    // 非安全環境（http）時的備援雜湊
    const a = new Uint8Array(buf)
    let h1 = 0x811c9dc5, h2 = a.length
    for (let i = 0; i < a.length; i += Math.max(1, (a.length / 2e6) | 0)) {
        h1 = Math.imul(h1 ^ a[i], 16777619) >>> 0
        h2 = Math.imul(h2 ^ a[i], 2246822519) >>> 0
    }
    return 'f' + h1.toString(16) + h2.toString(16) + a.length.toString(16)
}

/* ====================== 書庫畫面 ====================== */
const hue = s => [...(s || '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)

function visibleBooks() {
    return Object.values(library.books).filter(b => !b.deleted)
        .sort((a, b) => (b.progress?.updatedAt || b.addedAt || 0) - (a.progress?.updatedAt || a.addedAt || 0))
}

async function coverURL(id) {
    if (coverURLs.has(id)) return coverURLs.get(id)
    const blob = await db.get('covers', id)
    const url = blob ? URL.createObjectURL(blob) : null
    coverURLs.set(id, url)
    return url
}

async function renderLibrary() {
    const books = visibleBooks()
    const grid = $('#library-grid')
    $('#library-empty').classList.toggle('hidden', books.length > 0)
    const cards = await Promise.all(books.map(async b => {
        const url = localFiles.has(b.id) ? await coverURL(b.id) : null
        const pct = Math.round((b.progress?.percent || 0) * 100)
        const n = sortedHighlights(b).length
        const cover = url ? `<img src="${url}" alt="">`
            : `<div class="ph" style="background:hsl(${hue(b.title)} 35% 40%)">${esc(b.title)}<small>${esc(b.author || '')}</small></div>`
        return `<div class="book" data-id="${b.id}">
            <div class="cover">${cover}<span class="badge">${esc(b.format)}</span>
              ${localFiles.has(b.id) ? '' : '<span class="badge cloud">雲端</span>'}</div>
            <button class="book-menu" data-menu="${b.id}" title="更多">⋯</button>
            <div class="book-title">${esc(b.title)}</div>
            <div class="book-meta"><span>${pct}%</span><span>${n ? `🖍 ${n}` : ''}</span></div>
            <div class="progressbar"><div style="width:${pct}%"></div></div>
          </div>`
    }))
    grid.innerHTML = cards.join('')
}

$('#library-grid').addEventListener('click', e => {
    const menu = e.target.closest('[data-menu]')
    if (menu) { e.stopPropagation(); return bookMenu(menu.dataset.menu) }
    const card = e.target.closest('.book')
    if (card) openBookById(card.dataset.id)
})

function bookMenu(id) {
    const b = library.books[id]
    const n = sortedHighlights(b).length
    const body = openModal(b.title, `
        <button class="btn block" data-a="export"><span class="ic">📤</span><span>一鍵匯出閱讀重點<small>${n} 則重點 → Word / PDF / Markdown</small></span></button>
        <button class="btn block" data-a="info"><span class="ic">ℹ️</span><span>書籍資訊</span></button>
        <button class="btn block danger" data-a="delete"><span class="ic">🗑</span><span>從書庫移除<small>所有裝置都會移除，Drive 中的書檔會移到垃圾桶</small></span></button>`)
    body.onclick = e => {
        const a = e.target.closest('[data-a]')?.dataset.a
        if (a === 'export') exportDialog(id)
        if (a === 'info') {
            openModal('書籍資訊', `<p><b>${esc(b.title)}</b></p><p>作者：${esc(b.author || '—')}</p>
                <p>格式：${esc(b.format.toUpperCase())}・${(b.size / 1048576).toFixed(1)} MB</p>
                <p>檔名：${esc(b.fileName)}</p><p>加入時間：${exporter.fmtDate(b.addedAt)}</p>
                <p>重點：${n} 則</p><p>雲端：${b.driveFileId ? '已上傳 Google Drive' : '尚未上傳'}</p>
                <p>本機：${localFiles.has(b.id) ? '已下載' : '未下載（開啟時自動下載）'}</p>`)
        }
        if (a === 'delete') {
            if (!confirm(`確定要移除《${b.title}》嗎？\n重點也會一併隱藏（若重新匯入同一本書會恢復）。`)) return
            b.deleted = true
            b.updatedAt = Date.now()
            db.del('files', id); db.del('covers', id)
            localFiles.delete(id); coverURLs.delete(id)
            closeModal()
            saveLibrary()
            renderLibrary()
        }
    }
}

/* ====================== 匯入 ====================== */
$('#btn-import').onclick = () => $('#file-input').click()
$('#file-input').onchange = e => { importFiles([...e.target.files]); e.target.value = '' }
document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging') })
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging') })
document.addEventListener('drop', e => {
    e.preventDefault()
    document.body.classList.remove('dragging')
    if (e.dataTransfer?.files?.length) importFiles([...e.dataTransfer.files])
})

async function importFiles(files) {
    let added = 0
    for (const file of files) {
        const format = detectFormat(file.name)
        if (!format) { toast(`不支援的格式：${file.name}\n支援：${SUPPORTED.join(', ')}`, 4000); continue }
        loading(`匯入中：${file.name}`)
        try {
            const buf = await file.arrayBuffer()
            const id = await sha256Hex(buf)
            const existing = library.books[id]
            if (existing && !existing.deleted && localFiles.has(id)) { toast(`《${existing.title}》已在書庫中`); continue }
            const blob = new Blob([buf], { type: file.type || 'application/octet-stream' })
            const book = await openBook(new File([blob], file.name), format)
            let cover = null
            try {
                // 封面非必要：最多等 8 秒，避免卡住匯入
                cover = await Promise.race([
                    (async () => makeThumb(await book.getCover?.()))(),
                    new Promise(r => setTimeout(() => r(null), 8000)),
                ])
            } catch { /* 無封面 */ }
            book.destroy?.()
            await db.put('files', id, blob)
            if (cover) await db.put('covers', id, cover)
            coverURLs.delete(id)
            localFiles.add(id)
            const now = Date.now()
            library.books[id] = Object.assign(existing ?? {
                id, highlights: {}, progress: null, addedAt: now, driveFileId: null,
            }, {
                title: existing?.title || book.metadata.title,
                author: existing?.author || book.metadata.author || '',
                format, fileName: file.name, size: file.size,
                deleted: false, updatedAt: now,
            })
            added++
        } catch (err) {
            console.error(err)
            toast(`無法開啟 ${file.name}：${err.message || err}`, 5000)
        }
    }
    loading(null)
    if (added) {
        toast(`已匯入 ${added} 本書`)
        saveLibrary({ now: true })
        renderLibrary()
    }
}

/* ====================== 閱讀 ====================== */
function computeSectionTitles(book) {
    const n = book.kind === 'pdf' ? book.numPages : book.sections.length
    const first = new Array(n).fill(null)
    for (const t of book.toc) if (t.section >= 0 && t.section < n && first[t.section] == null) first[t.section] = t.label
    const out = []
    let last = ''
    for (let i = 0; i < n; i++) {
        last = first[i] ?? book.sections?.[i]?.title ?? last
        out.push(last)
    }
    return out
}

async function openBookById(id) {
    const r = library.books[id]
    if (!r) return
    try {
        let blob = await db.get('files', id)
        if (!blob) {
            if (!r.driveFileId) return toast('此書尚未上傳到雲端，請在原本的裝置上同步')
            if (!drive.hasValidToken()) {
                if (!drive.getClientId()) return toast('請先到設定連結 Google Drive')
                await drive.signIn()
                setSyncState('ok', '已連線 Google Drive')
            }
            loading(`從 Google Drive 下載《${r.title}》…`)
            blob = await drive.downloadBook(r.driveFileId)
            await db.put('files', id, blob)
            localFiles.add(id)
        }
        loading('開啟中…')
        const book = await openBook(new File([blob], r.fileName), r.format)
        if (!(await db.get('covers', id))) {
            try {
                const c = await makeThumb(await book.getCover?.())
                if (c) { await db.put('covers', id, c); coverURLs.delete(id) }
            } catch { /* ignore */ }
        }
        const sectionTitles = computeSectionTitles(book)
        const scroll = $('#reader-scroll'), content = $('#reader-content')
        content.replaceChildren()
        showView('reader')
        $('#reader-title').textContent = r.title
        const isPdf = book.kind === 'pdf'
        $('#btn-prev').textContent = isPdf ? '‹ 上一頁' : '‹ 上一章'
        $('#btn-next').textContent = isPdf ? '下一頁 ›' : '下一章 ›'
        $('#pdf-zoom').classList.toggle('hidden', !isPdf)
        const opts = {
            scroll, content, book,
            getHighlights: section => sortedHighlights(library.books[id]).filter(h => h.section === section),
            onRelocate: onRelocate,
            onLink: onLink,
        }
        const view = isPdf ? new PdfView(opts) : new FlowView(opts)
        current = { id, book, view, sectionTitles }
        if (isPdf) await view.init()
        const p = r.progress
        await view.show(p?.section ?? 0, { frac: p?.frac ?? 0 })
        loading(null)
    } catch (err) {
        console.error(err)
        loading(null)
        toast(`開啟失敗：${err.message || err}`, 5000)
        if (current?.id === id) closeReader()
    }
}

let progressTimer
function onRelocate(pos) {
    const r = rec()
    if (!r || pos.section < 0) return
    const v = current.view
    $('#reader-progress').textContent = current.book.kind === 'pdf'
        ? `第 ${pos.section + 1} / ${v.count} 頁`
        : `${current.sectionTitles[pos.section] ? current.sectionTitles[pos.section].slice(0, 14) + '・' : ''}${Math.round(pos.percent * 100)}%`
    $('#btn-prev').disabled = pos.section <= 0
    $('#btn-next').disabled = pos.section >= v.count - 1
    clearTimeout(progressTimer)
    progressTimer = setTimeout(() => {
        const r2 = rec()
        if (!r2) return
        r2.progress = { section: pos.section, frac: pos.frac, percent: pos.percent, updatedAt: Date.now() }
        saveLibrary({ sync: false })
        scheduleSync(15000)
    }, 800)
}

async function onLink(href, sectionIndex) {
    try {
        const r = await current.book.resolveLink(href, sectionIndex)
        if (!r) return
        if (r.external) { if (confirm(`開啟外部連結？\n${r.external}`)) window.open(r.external, '_blank', 'noopener'); return }
        await current.view.show(r.section, { anchor: r.anchor })
    } catch (e) { console.warn(e) }
}

function closeReader() {
    if (current) {
        const pos = current.view.position?.()
        const r = rec()
        if (r && pos && pos.section >= 0) r.progress = { section: pos.section, frac: pos.frac, percent: pos.percent, updatedAt: Date.now() }
        current.view.destroy?.()
        current.book.destroy?.()
        current = null
    }
    hideToolbars()
    closeDrawer()
    $('#reader-content').replaceChildren()
    showView('library')
    saveLibrary({ now: true })
    renderLibrary()
}

$('#btn-back').onclick = closeReader
$('#btn-prev').onclick = () => {
    if (!current) return
    const i = current.view.position().section
    current.view.show(i - 1, { frac: 0 })
}
$('#btn-next').onclick = () => {
    if (!current) return
    const i = current.view.position().section
    current.view.show(i + 1, { frac: 0 })
}
$('#btn-zoom-in').onclick = () => current?.view.setZoom?.(current.view.zoom * 1.2)
$('#btn-zoom-out').onclick = () => current?.view.setZoom?.(current.view.zoom / 1.2)

document.addEventListener('keydown', e => {
    if (!current || !$('#modal').classList.contains('hidden') || e.target.closest?.('input, textarea')) return
    if (e.key === 'ArrowRight' || e.key === 'PageDown' && e.ctrlKey) $('#btn-next').click()
    if (e.key === 'ArrowLeft') $('#btn-prev').click()
    if (e.key === 'Escape') closeReader()
})

/* ---------- 目錄 ---------- */
$('#btn-toc').onclick = () => {
    if (!current) return
    const { book, view } = current
    const here = view.position().section
    $('#drawer-tools').innerHTML = ''
    let items = book.toc
    if (!items.length) {
        items = book.kind === 'pdf'
            ? Array.from({ length: book.numPages }, (_, i) => ({ label: `第 ${i + 1} 頁`, section: i, depth: 0 }))
            : book.sections.map((s, i) => ({ label: s.title || `第 ${i + 1} 節`, section: i, depth: 0 }))
    }
    $('#drawer-body').innerHTML = items.map((t, i) =>
        `<button class="toc-item ${t.section === here ? 'current' : ''}" data-i="${i}" style="padding-left:${16 + t.depth * 18}px">${esc(t.label)}</button>`).join('')
    $('#drawer-body').onclick = e => {
        const b = e.target.closest('[data-i]')
        if (!b) return
        const t = items[+b.dataset.i]
        if (t.section < 0) return toast('無法跳到此章節')
        closeDrawer()
        view.show(t.section, { anchor: t.anchor })
    }
    openDrawer('目錄')
    $('#drawer-body .current')?.scrollIntoView({ block: 'center' })
}

/* ---------- 重點清單 ---------- */
function renderHighlightsDrawer() {
    const r = rec()
    const list = sortedHighlights(r)
    $('#drawer-tools').innerHTML = `<button class="chip primary" data-t="export">📤 一鍵匯出（${list.length}）</button>`
    $('#drawer-tools').onclick = e => { if (e.target.closest('[data-t=export]')) exportDialog(r.id) }
    if (!list.length) {
        $('#drawer-body').innerHTML = `<p class="muted" style="padding:16px;line-height:1.7">還沒有重點。<br>在書中<b>選取文字</b>，再點選顏色即可標示。</p>`
        return
    }
    let html = '', lastCh = null
    for (const h of list) {
        const ch = h.chapter || (r.format === 'pdf' ? `第 ${h.section + 1} 頁` : '')
        if (ch !== lastCh) { html += `<div class="hl-group">${esc(ch)}</div>`; lastCh = ch }
        html += `<div class="hl-item" data-id="${h.id}">
            <div class="hl-text c-${h.color}">${esc(h.text.length > 300 ? h.text.slice(0, 300) + '…' : h.text)}</div>
            ${h.note ? `<div class="hl-note">📝 ${esc(h.note)}</div>` : ''}
            <div class="hl-date">${r.format === 'pdf' ? `第 ${h.section + 1} 頁・` : ''}${exporter.fmtDate(h.createdAt)}</div></div>`
    }
    $('#drawer-body').innerHTML = html
    $('#drawer-body').onclick = e => {
        const item = e.target.closest('.hl-item')
        if (!item) return
        const h = r.highlights[item.dataset.id]
        closeDrawer()
        current.view.show(h.section, { highlightId: h.id })
    }
}
$('#btn-highlights').onclick = () => {
    if (!current) return
    renderHighlightsDrawer()
    openDrawer('閱讀重點')
}

/* ---------- 外觀 ---------- */
$('#btn-appearance').onclick = () => {
    const body = openModal('字體與主題', `
        <label>字體大小</label>
        <div class="row"><button class="btn" data-a="fs-">A－</button><span id="fs-val" style="min-width:48px;text-align:center">${settings.fontSize}</span><button class="btn" data-a="fs+">A＋</button></div>
        <label>行距</label>
        <div class="row">${[1.5, 1.8, 2.1].map(v => `<button class="btn ${settings.lineHeight === v ? 'selected' : ''}" data-lh="${v}">${v}</button>`).join('')}</div>
        <label>字型</label>
        <div class="row"><button class="btn ${settings.font === 'sans' ? 'selected' : ''}" data-font="sans">黑體</button><button class="btn ${settings.font === 'serif' ? 'selected' : ''}" data-font="serif" style="font-family:serif">明體</button></div>
        <label>主題</label>
        <div class="row">${[['light', '白天'], ['sepia', '護眼'], ['dark', '夜間']].map(([k, n]) => `<button class="btn ${settings.theme === k ? 'selected' : ''}" data-theme="${k}">${n}</button>`).join('')}</div>
        <p class="hint">PDF 頁面請用右下角 ＋／－ 縮放。</p>`)
    body.onclick = e => {
        const t = e.target.closest('button')
        if (!t) return
        if (t.dataset.a === 'fs-') settings.fontSize = Math.max(12, settings.fontSize - 1)
        if (t.dataset.a === 'fs+') settings.fontSize = Math.min(40, settings.fontSize + 1)
        if (t.dataset.lh) settings.lineHeight = +t.dataset.lh
        if (t.dataset.font) settings.font = t.dataset.font
        if (t.dataset.theme) settings.theme = t.dataset.theme
        applySettings()
        $('#fs-val') && ($('#fs-val').textContent = settings.fontSize)
        if (t.dataset.lh || t.dataset.font || t.dataset.theme) {
            t.parentElement.querySelectorAll('.btn').forEach(b => b.classList.toggle('selected', b === t))
        }
    }
}

/* ====================== 選取 → 標示重點 ====================== */
const selBar = $('#sel-toolbar'), hlBar = $('#hl-toolbar')
let pendingSel = null, activeHl = null, toolbarPress = false

function hideToolbars() {
    selBar.classList.add('hidden')
    hlBar.classList.add('hidden')
    pendingSel = null
    activeHl = null
}

function placeBar(bar, rect) {
    bar.classList.remove('hidden')
    const bw = bar.offsetWidth, bh = bar.offsetHeight
    const vw = window.innerWidth, vh = window.innerHeight
    let top = rect.bottom + 12                         // 預設放在選取範圍下方（避開 iOS 原生選單）
    if (top + bh > vh - 60) top = rect.top - bh - 12   // 下方空間不足就放上方
    top = Math.max(8, Math.min(vh - bh - 8, top))
    let left = rect.left + rect.width / 2 - bw / 2
    left = Math.max(8, Math.min(vw - bw - 8, left))
    bar.style.top = top + 'px'
    bar.style.left = left + 'px'
}

function checkSelection() {
    if (toolbarPress || !current) return
    const sel = getSelection()
    if (!sel.rangeCount || sel.isCollapsed) {
        if (!selBar.classList.contains('hidden')) { selBar.classList.add('hidden'); pendingSel = null }
        return
    }
    const range = sel.getRangeAt(0)
    const info = current.view.rootFor(range.startContainer)
    if (!info) return
    let { start, end } = rangeToOffsets(info.root, range)
    const raw = textAt(info.root, start, end)
    const lead = raw.length - raw.trimStart().length
    const trail = raw.length - raw.trimEnd().length
    start += lead; end -= trail
    if (end - start < 1) return
    pendingSel = { section: info.section, start, end, text: textAt(info.root, start, end) }
    hlBar.classList.add('hidden')
    const rects = range.getClientRects()
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
    const first = rects[0] ?? last
    placeBar(selBar, { top: first.top, bottom: last.bottom, left: Math.min(first.left, last.left), width: Math.abs(last.right - first.left) })
    selBar.querySelectorAll('.swatch').forEach(s => s.classList.toggle('current', s.dataset.color === settings.lastColor))
}
let selTimer
document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(checkSelection, 250) })

for (const bar of [selBar, hlBar]) {
    bar.addEventListener('pointerdown', e => { e.preventDefault(); toolbarPress = true })
    bar.addEventListener('mousedown', e => e.preventDefault())
}
document.addEventListener('pointerup', () => setTimeout(() => { toolbarPress = false }, 400))

function createHighlight(color, note = '') {
    const r = rec(), p = pendingSel
    if (!r || !p) return null
    const now = Date.now()
    const hl = {
        id: newId(), section: p.section, start: p.start, end: p.end, text: p.text,
        color, note, chapter: current.sectionTitles[p.section] || '', createdAt: now, updatedAt: now,
    }
    r.highlights[hl.id] = hl
    for (const root of current.view.rootsForSection(p.section)) wrapHighlight(root, hl)
    settings.lastColor = color
    applySettings()
    getSelection().removeAllRanges()
    hideToolbars()
    saveLibrary()
    return hl
}

selBar.addEventListener('click', e => {
    const b = e.target.closest('button')
    if (!b || !pendingSel) return
    if (b.dataset.color) { createHighlight(b.dataset.color); toast('已標示重點', 1200) }
    if (b.dataset.act === 'copy') {
        navigator.clipboard?.writeText(pendingSel.text).then(() => toast('已複製'), () => toast('無法複製'))
        getSelection().removeAllRanges(); hideToolbars()
    }
    if (b.dataset.act === 'note') {
        const p = pendingSel
        noteDialog(p.text, '', note => { pendingSel = p; createHighlight(settings.lastColor, note) })
    }
})

function noteDialog(text, note, onSave) {
    const body = openModal('筆記', `
        <div class="quote c-${settings.lastColor}">${esc(text)}</div>
        <label>你的想法</label><textarea id="note-text" placeholder="寫下筆記…">${esc(note)}</textarea>
        <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-a="cancel">取消</button><button class="btn primary" data-a="save">儲存</button></div>`)
    setTimeout(() => $('#note-text')?.focus(), 50)
    body.onclick = e => {
        const a = e.target.closest('[data-a]')?.dataset.a
        if (a === 'cancel') closeModal()
        if (a === 'save') { onSave($('#note-text').value.trim()); closeModal() }
    }
}

// 點擊既有重點
$('#reader-content').addEventListener('click', e => {
    const m = e.target.closest('mark.hl')
    if (!m || !current) return
    if (!getSelection().isCollapsed) return
    const r = rec()
    const hl = r?.highlights[m.dataset.id]
    if (!hl || hl.deleted) return
    e.preventDefault()
    e.stopPropagation()
    activeHl = hl
    selBar.classList.add('hidden')
    hlBar.querySelectorAll('.swatch').forEach(s => s.classList.toggle('current', s.dataset.color === hl.color))
    placeBar(hlBar, m.getBoundingClientRect())
}, true)

hlBar.addEventListener('click', e => {
    const b = e.target.closest('button')
    const hl = activeHl
    if (!b || !hl || !current) return
    const roots = current.view.rootsForSection(hl.section)
    if (b.dataset.color) {
        hl.color = b.dataset.color
        hl.updatedAt = Date.now()
        roots.forEach(root => updateHighlightMarks(root, hl))
        hideToolbars(); saveLibrary()
    }
    if (b.dataset.act === 'note') {
        hideToolbars()
        noteDialog(hl.text, hl.note || '', note => {
            hl.note = note
            hl.updatedAt = Date.now()
            roots.forEach(root => updateHighlightMarks(root, hl))
            saveLibrary()
        })
    }
    if (b.dataset.act === 'delete') {
        hl.deleted = true
        hl.updatedAt = Date.now()
        roots.forEach(root => unwrapHighlight(root, hl.id))
        hideToolbars(); saveLibrary()
        toast('已刪除重點', 1200)
    }
})

document.addEventListener('pointerdown', e => {
    if (e.target.closest('.sel-toolbar') || e.target.closest('mark.hl')) return
    if (!hlBar.classList.contains('hidden')) { hlBar.classList.add('hidden'); activeHl = null }
})
$('#reader-scroll').addEventListener('scroll', () => {
    if (!hlBar.classList.contains('hidden')) { hlBar.classList.add('hidden'); activeHl = null }
    if (pendingSel && !selBar.classList.contains('hidden')) { clearTimeout(selTimer); selTimer = setTimeout(checkSelection, 150) }
}, { passive: true })

/** 同步後重新繪製畫面上的重點 */
function redrawHighlights() {
    if (!current) return
    const r = rec()
    const v = current.view
    const n = v.count
    for (let s = 0; s < n; s++) {
        for (const root of v.rootsForSection(s)) {
            root.querySelectorAll('mark.hl').forEach(m => unwrapHighlight(root, m.dataset.id))
            applyHighlights(root, sortedHighlights(r).filter(h => h.section === s))
        }
    }
}

/* ====================== 匯出 ====================== */
function exportDialog(id) {
    const r = library.books[id]
    const n = sortedHighlights(r).length
    if (!n) return toast('這本書還沒有任何重點')
    const linked = drive.isLinked()
    const body = openModal('匯出閱讀重點', `
        <p style="margin:0 0 10px">《${esc(r.title)}》共 <b>${n}</b> 則重點</p>
        <label class="check"><input type="checkbox" id="ex-notes" checked> 包含筆記</label>
        <label class="check"><input type="checkbox" id="ex-chapter" checked> 依章節分組</label>
        <div style="margin-top:14px">
        <button class="btn block" data-f="docx"><span class="ic">📄</span><span>Word（.docx）<small>可直接用 Word / Pages / Google 文件開啟編輯</small></span></button>
        <button class="btn block" data-f="pdf"><span class="ic">📕</span><span>PDF<small>開啟列印畫面 → 選「另存為 PDF」（iPhone：分享 → 儲存到檔案）</small></span></button>
        <button class="btn block" data-f="md"><span class="ic">📝</span><span>Markdown（.md）<small>適合 Notion、Obsidian</small></span></button>
        <button class="btn block" data-f="copy"><span class="ic">📋</span><span>複製全部文字</span></button>
        ${linked ? `<button class="btn block" data-f="gdoc"><span class="ic">☁️</span><span>存成 Google 文件<small>存到 Drive 的「EbookReader」資料夾</small></span></button>` : ''}
        </div>`)
    body.onclick = e => {
        const f = e.target.closest('[data-f]')?.dataset.f
        if (!f) return
        const opts = { notes: $('#ex-notes').checked, byChapter: $('#ex-chapter').checked }
        // 注意：以下需同步執行，iOS 才允許開啟分享面板
        if (f === 'docx') exporter.deliver(exporter.toDocx(r, opts), exporter.exportFileName(r, 'docx')).then(res => res === 'downloaded' && toast('已下載 Word 檔'))
        if (f === 'md') exporter.deliver(new Blob([exporter.toMarkdown(r, opts)], { type: 'text/markdown' }), exporter.exportFileName(r, 'md')).then(res => res === 'downloaded' && toast('已下載 Markdown 檔'))
        if (f === 'pdf') { closeModal(); closeDrawer(); setTimeout(() => exporter.printPDF(r, opts), 50) }
        if (f === 'copy') navigator.clipboard?.writeText(exporter.toPlainText(r, opts)).then(() => toast('已複製到剪貼簿'), () => toast('無法複製'))
        if (f === 'gdoc') saveToGoogleDoc(r, opts)
    }
}

async function saveToGoogleDoc(r, opts) {
    try {
        if (!drive.hasValidToken()) await drive.signIn()
        loading('建立 Google 文件中…')
        const folder = await drive.ensureFolder()
        const doc = await drive.createGoogleDoc(`${r.title} 閱讀重點`, exporter.toDocsHTML(r, opts), folder)
        loading(null)
        closeModal()
        if (doc.webViewLink && confirm('已存成 Google 文件，要現在開啟嗎？')) window.open(doc.webViewLink, '_blank', 'noopener')
        else toast('已存到 Google Drive 的 EbookReader 資料夾')
    } catch (e) {
        loading(null)
        toast(e.message || String(e), 5000)
    }
}

/* ====================== Google Drive 同步 ====================== */
let syncing = false, syncAgain = false, syncTimer

function setSyncState(state, text = '') {
    $('#sync-dot').className = 'dot ' + state
    $('#sync-status').textContent = text
}

function scheduleSync(delay = 4000) {
    if (!drive.isLinked() || !drive.getClientId()) return
    clearTimeout(syncTimer)
    syncTimer = setTimeout(() => syncNow(false), delay)
}

async function syncNow(interactive) {
    if (!drive.getClientId()) { if (interactive) settingsDialog(); return }
    if (syncing) { syncAgain = true; return }
    clearTimeout(syncTimer)
    syncing = true
    try {
        if (!drive.hasValidToken()) {
            if (!interactive) { setSyncState('err', 'Google 登入已逾時，點右上角雲朵重新同步'); return }
            await drive.signIn()
        }
        setSyncState('busy', '同步中…')
        const folder = await drive.ensureFolder()
        const remote = await drive.loadRemoteLibrary(folder)
        const before = JSON.stringify(rec()?.highlights ?? {})
        library = drive.mergeLibraries(library, remote.data)
        // 上傳本機才有的書檔
        for (const b of Object.values(library.books)) {
            if (b.deleted || b.driveFileId || !localFiles.has(b.id)) continue
            setSyncState('busy', `上傳《${b.title}》…`)
            const blob = await db.get('files', b.id)
            if (!blob) continue
            const fileId = await drive.uploadBook(blob, b.fileName, folder)
            const live = library.books[b.id]   // 上傳期間 library 可能被更新
            live.driveFileId = fileId
            live.driveTrashed = false
            live.updatedAt = Date.now()
        }
        // 已刪除的書：Drive 中的檔案移到垃圾桶
        for (const b of Object.values(library.books)) {
            if (!b.deleted || !b.driveFileId || b.driveTrashed) continue
            try { await drive.trashFile(b.driveFileId) } catch (e) { if (e.status !== 404) console.warn(e) }
            b.driveTrashed = true
            b.updatedAt = Date.now()
        }
        await db.put('kv', 'library', library)
        await drive.saveRemoteLibrary(folder, remote.id, library)
        const t = new Date()
        setSyncState('ok', `已與 Google Drive 同步（${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}）`)
        if ($('#view-library').classList.contains('active')) renderLibrary()
        else if (JSON.stringify(rec()?.highlights ?? {}) !== before) redrawHighlights()
    } catch (e) {
        console.error(e)
        if (e instanceof drive.AuthError) setSyncState('err', '需要重新登入 Google，點右上角雲朵')
        else setSyncState('err', '同步失敗：' + (e.message || e))
        if (interactive) toast(e.message || String(e), 5000)
    } finally {
        syncing = false
        if (syncAgain) { syncAgain = false; scheduleSync(1500) }
    }
}

$('#btn-sync').onclick = () => {
    if (!drive.getClientId() || !drive.isLinked()) return settingsDialog()
    syncNow(true)
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        if (current) {
            const pos = current.view.position(), r = rec()
            if (r && pos.section >= 0) r.progress = { section: pos.section, frac: pos.frac, percent: pos.percent, updatedAt: Date.now() }
        }
        saveLibrary({ now: true, sync: false })
        if (drive.isLinked() && drive.hasValidToken()) syncNow(false)
    } else if (drive.isLinked() && drive.hasValidToken()) {
        syncNow(false)
    }
})

/* ====================== 設定 ====================== */
$('#btn-settings').onclick = () => settingsDialog()

async function settingsDialog() {
    const linked = drive.isLinked()
    let usage = ''
    try {
        const est = await navigator.storage?.estimate?.()
        if (est) usage = `本機已使用 ${(est.usage / 1048576).toFixed(0)} MB`
    } catch { /* ignore */ }
    const body = openModal('設定', `
        <h3 style="margin:0 0 4px;font-size:16px">☁️ Google Drive 同步</h3>
        <p class="hint">書檔、閱讀進度與重點會存在你 Drive 的「EbookReader」資料夾，iPhone、Android、Windows 登入同一個 Google 帳號即可同步。</p>
        <label>Google OAuth 用戶端 ID</label>
        <input type="text" id="client-id" value="${esc(drive.getClientId())}" placeholder="xxxxxxxx.apps.googleusercontent.com" autocomplete="off" spellcheck="false">
        <p class="hint">第一次使用需建立（約 5 分鐘），步驟見 README.md。</p>
        <div class="row" style="margin-top:10px">
          ${linked
            ? `<button class="btn primary" data-a="sync">立即同步</button><button class="btn danger" data-a="unlink">中斷連結</button>`
            : `<button class="btn primary" data-a="link">連結 Google Drive</button>`}
        </div>
        <h3 style="margin:22px 0 4px;font-size:16px">📚 其他</h3>
        <p class="hint">${usage}${usage ? '・' : ''}支援格式：EPUB、PDF、MOBI、AZW3、TXT（自動判斷 UTF-8 / Big5 / GBK）、DOCX、FB2、CBZ</p>
        <p class="hint">安裝成 App：iPhone 用 Safari 開啟 → 分享 → 加入主畫面；Android 用 Chrome → 安裝應用程式；Windows 用 Edge / Chrome 網址列右側的「安裝」圖示。</p>`)
    body.onclick = async e => {
        const a = e.target.closest('[data-a]')?.dataset.a
        if (!a) return
        const id = $('#client-id').value.trim()
        if (id !== drive.getClientId()) drive.setClientId(id)
        if (a === 'link' || a === 'sync') {
            if (!id) return toast('請先貼上用戶端 ID')
            closeModal()
            await syncNow(true)
            if (drive.isLinked()) toast('已連結 Google Drive')
        }
        if (a === 'unlink') {
            if (!confirm('中斷與 Google Drive 的連結？（本機與雲端資料都不會刪除）')) return
            drive.signOut()
            setSyncState('off', '')
            closeModal()
        }
    }
    $('#client-id').onchange = e => { drive.setClientId(e.target.value); if (e.target.value.trim()) drive.loadGIS().catch(() => {}) }
    if (drive.getClientId()) drive.loadGIS().catch(() => {})
}

/* ====================== 啟動 ====================== */
async function init() {
    applySettings()
    db.persist()
    try {
        library = (await db.get('kv', 'library')) ?? { version: 1, books: {} }
        for (const k of await db.keys('files')) localFiles.add(k)
    } catch (e) {
        console.error(e)
        toast('無法存取本機資料庫：' + e.message, 6000)
    }
    await renderLibrary()
    if (drive.getClientId()) drive.loadGIS().catch(() => {})
    if (drive.isLinked() && drive.getClientId()) {
        if (drive.hasValidToken()) syncNow(false)
        else setSyncState('err', '點右上角雲朵與 Google Drive 同步')
    }
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW 註冊失敗', e))
    }
}
init()

// 方便除錯
globalThis.__app = { get library() { return library }, get current() { return current }, flash, importFiles, openBookById, exportDialog }
