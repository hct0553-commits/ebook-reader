import * as db from './db.js'
import * as drive from './drive.js'
import { openBook, detectFormat, makeThumb, SUPPORTED } from './formats.js'
import { FlowView, PdfView, flash } from './reader.js'
import {
    rangeToOffsets, textAt, wrapHighlight, unwrapHighlight, updateHighlightMarks,
    applyHighlights, newId, sortedHighlights, COLORS,
} from './highlights.js'
import * as exporter from './export.js'
import { toSimplified } from './t2s.js'

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
    $('#modal').classList.remove('wide')
    const body = $('#modal-body')
    body.onclick = body.onchange = body.oninput = null   // 對話框共用同一個容器，先清掉上一個的事件
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

const RECENT_LIMIT = 50
// 最後一次「開啟」的時間；舊資料沒有 openedAt 時，以最後閱讀進度時間代替
const lastOpened = b => b.openedAt || b.progress?.updatedAt || 0
const collator = new Intl.Collator('zh-Hant-TW', { numeric: true, sensitivity: 'base' })
const SORTS = {
    title: { label: '依書名', cmp: (a, b) => collator.compare(a.title || '', b.title || '') },
    author: {
        label: '依作者',
        // 沒有作者的書排在最後
        cmp: (a, b) => (!a.author - !b.author) || collator.compare(a.author || '', b.author || '') || SORTS.title.cmp(a, b),
    },
    added: { label: '依加入時間', cmp: (a, b) => (b.addedAt || 0) - (a.addedAt || 0) },
}
let librarySort = SORTS[localStorage.getItem('librarySort')] ? localStorage.getItem('librarySort') : 'title'

function visibleBooks() {
    return Object.values(library.books).filter(b => !b.deleted)
}

// 搜尋用的正規化：全形轉半形、不分大小寫、繁體轉簡體（簡繁互通）
const normalize = s => toSimplified(String(s || '').normalize('NFKC').toLowerCase())
function matches(b, terms) {
    const hay = normalize(`${b.title} ${b.author || ''} ${b.fileName || ''}`)
    return terms.every(t => hay.includes(t))
}

async function coverURL(id) {
    if (coverURLs.has(id)) return coverURLs.get(id)
    const blob = await db.get('covers', id)
    const url = blob ? URL.createObjectURL(blob) : null
    coverURLs.set(id, url)
    return url
}

let renderSeq = 0
async function renderLibrary() {
    const seq = ++renderSeq
    const books = visibleBooks()
    const list = $('#library-grid')
    $('#library-empty').classList.toggle('hidden', books.length > 0)
    $('#lib-tools').classList.toggle('hidden', books.length === 0)
    const query = $('#lib-search').value.trim()
    $('#lib-search-clear').classList.toggle('hidden', !query)

    const section = (title, count, items, extra = '') => items.length
        ? `<div class="lib-head"><span>${title}</span><span class="count">${count}</span>${extra}</div>
           <div class="grid">${items.join('')}</div>` : ''
    let html
    if (query) {
        const terms = normalize(query).split(/\s+/).filter(Boolean)
        const found = books.filter(b => matches(b, terms))
            .sort((a, b) => (lastOpened(b) - lastOpened(a)) || SORTS.title.cmp(a, b))
        const cards = await Promise.all(found.map(bookCard))
        html = found.length
            ? section('搜尋結果', `找到 ${found.length} 本`, cards)
            : `<div class="lib-note">找不到符合「${esc(query)}」的書<br>可以試試書名或作者的其中幾個字</div>`
    } else {
        const recent = books.filter(lastOpened).sort((a, b) => lastOpened(b) - lastOpened(a)).slice(0, RECENT_LIMIT)
        const inRecent = new Set(recent.map(b => b.id))
        const rest = books.filter(b => !inRecent.has(b.id)).sort(SORTS[librarySort].cmp)
        const [rc, oc] = await Promise.all([Promise.all(recent.map(bookCard)), Promise.all(rest.map(bookCard))])
        const sortSel = `<select id="lib-sort" aria-label="排序">${Object.entries(SORTS).map(([k, v]) =>
            `<option value="${k}"${k === librarySort ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`
        html = section('📖 最近閱讀', `${recent.length} 本`, rc)
            + section(recent.length ? '📚 其他書籍' : '📚 全部書籍', `${rest.length} 本`, oc, sortSel)
    }
    if (seq !== renderSeq) return   // 打字太快時，只顯示最後一次的結果
    list.innerHTML = html
}

async function bookCard(b) {
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
        ${b.author ? `<div class="book-author">${esc(b.author)}</div>` : ''}
        <div class="book-meta"><span>${pct}%</span><span>${n ? `🖍 ${n}` : ''}</span></div>
        <div class="progressbar"><div style="width:${pct}%"></div></div>
      </div>`
}

let searchTimer
$('#lib-search').addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(renderLibrary, 150)
})
$('#lib-search').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.target.value = ''; renderLibrary() }
    if (e.key === 'Enter') e.target.blur()   // 手機上收起鍵盤
})
$('#lib-search-clear').onclick = () => {
    $('#lib-search').value = ''
    renderLibrary()
    $('#lib-search').focus()
}
$('#library-grid').addEventListener('change', e => {
    if (e.target.id !== 'lib-sort') return
    librarySort = e.target.value
    localStorage.setItem('librarySort', librarySort)
    renderLibrary()
})

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
            const info = openModal('書籍資訊', `
                <label for="bi-title">書名</label>
                <input type="text" id="bi-title" value="${esc(b.title)}" autocomplete="off">
                <label for="bi-author">作者</label>
                <input type="text" id="bi-author" value="${esc(b.author || '')}" placeholder="例如：錢穆" autocomplete="off">
                <div class="row" style="margin-top:12px"><button class="btn primary" id="bi-save">儲存</button>
                  <span class="hint">修改後會同步到其他裝置，搜尋也會用新的書名與作者</span></div>
                <p class="hint" style="margin-top:16px;font-size:13px">
                格式：${esc(b.format.toUpperCase())}・${(b.size / 1048576).toFixed(1)} MB<br>
                檔名：${esc(b.fileName)}<br>加入時間：${exporter.fmtDate(b.addedAt)}<br>
                ${lastOpened(b) ? `最後開啟：${exporter.fmtDate(lastOpened(b))}<br>` : ''}
                重點：${n} 則<br>雲端：${b.driveFileId ? '已上傳 Google Drive' : '尚未上傳'}<br>
                本機：${localFiles.has(b.id) ? '已下載' : '未下載（開啟時自動下載）'}</p>`)
            info.querySelector('#bi-save').onclick = () => {
                const title = info.querySelector('#bi-title').value.trim()
                const author = info.querySelector('#bi-author').value.trim()
                if (!title) return toast('書名不能空白')
                if (title !== b.title || author !== (b.author || '')) {
                    b.title = title
                    b.author = author
                    b.updatedAt = Date.now()
                    saveLibrary({ now: true })
                    renderLibrary()
                }
                closeModal()
                toast('已更新書籍資訊')
            }
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
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const fmtSize = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

$('#btn-import').onclick = () => {
    const body = openModal('匯入電子書', `
        <button class="btn block" data-a="files"><span class="ic">📄</span><span>選擇檔案<small>可一次多選</small></span></button>
        <button class="btn block" data-a="folder"${isIOS ? ' disabled' : ''}><span class="ic">📂</span><span>掃描資料夾<small>${isIOS
            ? 'iPhone 的 Safari 不支援選擇資料夾，請改用「選擇檔案」多選'
            : '連子資料夾一起找出可匯入的書，再全選或勾選匯入'}</small></span></button>
        <p class="hint">電腦上也可以直接把檔案或整個資料夾拖進書庫。</p>`)
    body.onclick = e => {
        const a = e.target.closest('[data-a]')?.dataset.a
        if (!a) return
        closeModal()
        $(a === 'files' ? '#file-input' : '#folder-input').click()
    }
}
$('#file-input').onchange = e => { importFiles([...e.target.files]); e.target.value = '' }
$('#folder-input').onchange = e => {
    const files = [...e.target.files]
    e.target.value = ''
    const root = files[0]?.webkitRelativePath?.split('/')[0] || '資料夾'
    scanDialog(files.map(f => ({ file: f, path: f.webkitRelativePath || f.name })), root)
}
document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging') })
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging') })
document.addEventListener('drop', async e => {
    e.preventDefault()
    document.body.classList.remove('dragging')
    const entries = [...(e.dataTransfer?.items ?? [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean)
    if (entries.some(en => en.isDirectory)) {
        loading('掃描資料夾中…')
        try {
            const found = []
            for (const en of entries) await walkEntry(en, found)
            loading(null)
            scanDialog(found, entries.length === 1 ? entries[0].name : '拖入的資料夾')
        } catch (err) { loading(null); toast(`無法讀取資料夾：${err.message || err}`, 5000) }
        return
    }
    if (e.dataTransfer?.files?.length) importFiles([...e.dataTransfer.files])
})

// 遞迴讀取拖進來的資料夾
async function walkEntry(entry, out) {
    if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej))
        out.push({ file, path: entry.fullPath.replace(/^\//, '') })
    } else if (entry.isDirectory) {
        const reader = entry.createReader()
        for (;;) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
            if (!batch.length) break
            for (const en of batch) await walkEntry(en, out)
        }
    }
}

/* ---------- 掃描資料夾：列出可匯入的書，全選或勾選 ---------- */
function scanDialog(found, rootName) {
    const owned = new Set(visibleBooks().map(b => `${b.fileName}|${b.size}`))
    const items = found.map(({ file, path }) => {
        const fmt = detectFormat(file.name)
        if (!fmt || file.name.startsWith('.')) return null
        const parts = path.split('/')
        return {
            file, fmt, name: file.name, size: file.size,
            dir: parts.slice(1, -1).join(' / '),
            dup: owned.has(`${file.name}|${file.size}`),
        }
    }).filter(Boolean)
        .sort((a, b) => collator.compare(a.dir, b.dir) || collator.compare(a.name, b.name))
    items.forEach((it, i) => { it.i = i; it.key = normalize(`${it.name} ${it.dir}`) })
    const others = found.length - items.length
    const nDup = items.filter(it => it.dup).length
    if (!items.length) {
        openModal('掃描資料夾', `<p>「${esc(rootName)}」裡沒有可匯入的電子書。</p>
            <p class="hint">共檢查 ${found.length} 個檔案。支援格式：${SUPPORTED.join('、').toUpperCase()}</p>`)
        return
    }
    const fmts = [...new Set(items.map(it => it.fmt))].sort()
    const fmtOn = new Set(fmts)
    const selected = new Set()
    let query = ''

    const body = openModal(`📂 ${rootName}`, `
        <div class="scan-sum">找到 <b>${items.length}</b> 本可匯入${nDup ? `（其中 ${nDup} 本已在書架，標灰不可選）` : ''}
          ${others ? `・略過 ${others} 個非電子書檔案` : ''}</div>
        <div class="scan-tools">
          <div class="search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 3a6.5 6.5 0 0 1 5.2 10.4l5.5 5.5-1.4 1.4-5.5-5.5A6.5 6.5 0 1 1 9.5 3zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/></svg>
            <input type="search" id="scan-q" placeholder="在結果中搜尋檔名或資料夾" autocomplete="off" spellcheck="false">
          </div>
          <button class="btn" data-a="all">全選</button><button class="btn" data-a="none">全不選</button>
        </div>
        ${fmts.length > 1 ? `<div class="scan-tools">${fmts.map(f =>
            `<button class="chip on" data-fmt="${f}">${f.toUpperCase()} ${items.filter(it => it.fmt === f).length}</button>`).join('')}</div>` : ''}
        <div class="scan-list" id="scan-list"></div>
        <div class="scan-foot"><span class="info" id="scan-info"></span>
          <button class="btn primary" id="scan-go" disabled>匯入</button></div>`)
    $('#modal').classList.add('wide')

    const visible = () => items.filter(it => fmtOn.has(it.fmt) && (!query || query.every(t => it.key.includes(t))))
    const updateFoot = () => {
        const sel = items.filter(it => selected.has(it.i))
        const size = sel.reduce((n, it) => n + it.size, 0)
        body.querySelector('#scan-info').textContent = sel.length ? `已選 ${sel.length} 本・${fmtSize(size)}` : '尚未選擇'
        const go = body.querySelector('#scan-go')
        go.disabled = !sel.length
        go.textContent = sel.length ? `匯入 ${sel.length} 本` : '匯入'
    }
    const renderList = () => {
        const vis = visible()
        body.querySelector('#scan-list').innerHTML = vis.length ? vis.map(it => `
            <label class="scan-row${it.dup ? ' dup' : ''}">
              <input type="checkbox" data-i="${it.i}"${it.dup ? ' disabled' : selected.has(it.i) ? ' checked' : ''}>
              <span class="nm"><b>${esc(it.name)}</b><small>${it.dup ? '已在書架・' : ''}${esc(it.dir || '（最上層）')}</small></span>
              <span class="sz">${fmtSize(it.size)}</span>
            </label>`).join('') : '<div class="lib-note">沒有符合條件的檔案</div>'
        updateFoot()
    }
    body.onchange = e => {
        const i = e.target.dataset?.i
        if (i == null) return
        e.target.checked ? selected.add(+i) : selected.delete(+i)
        updateFoot()
    }
    body.oninput = e => {
        if (e.target.id !== 'scan-q') return
        query = normalize(e.target.value).split(/\s+/).filter(Boolean)
        if (!query.length) query = ''
        renderList()
    }
    body.onclick = e => {
        const chip = e.target.closest('[data-fmt]')
        if (chip) {
            const f = chip.dataset.fmt
            fmtOn.has(f) ? fmtOn.delete(f) : fmtOn.add(f)
            chip.classList.toggle('on', fmtOn.has(f))
            return renderList()
        }
        const a = e.target.closest('[data-a]')?.dataset.a
        // 全選／全不選只作用在目前篩選後看得到的書
        if (a === 'all') { visible().forEach(it => !it.dup && selected.add(it.i)); renderList() }
        if (a === 'none') { visible().forEach(it => selected.delete(it.i)); renderList() }
        if (e.target.id === 'scan-go') {
            const files = items.filter(it => selected.has(it.i)).map(it => it.file)
            closeModal()
            importFiles(files)
        }
    }
    renderList()
}

let stopImport = false
$('#loading-stop').onclick = () => { stopImport = true; loading('即將停止，完成目前這一本…') }

async function importFiles(files) {
    let added = 0, skipped = 0
    const failed = [], batch = files.length > 1
    stopImport = false
    $('#loading-stop').classList.toggle('hidden', files.length < 3)
    for (const [k, file] of files.entries()) {
        if (stopImport) break
        const format = detectFormat(file.name)
        if (!format) { failed.push([file.name, '不支援的格式']); continue }
        loading(batch ? `匯入中（${k + 1} / ${files.length}）\n${file.name}` : `匯入中：${file.name}`)
        try {
            const buf = await file.arrayBuffer()
            const id = await sha256Hex(buf)
            const existing = library.books[id]
            if (existing && !existing.deleted && localFiles.has(id)) {
                skipped++
                if (!batch) toast(`《${existing.title}》已在書庫中`)
                continue
            }
            const blob = new Blob([buf], { type: file.type || 'application/octet-stream' })
            const book = await openBook(new File([blob], file.name), format)
            let cover = null
            try {
                // 封面非必要：單本最多等 8 秒，大批匯入時 3 秒，避免卡住
                cover = await Promise.race([
                    (async () => makeThumb(await book.getCover?.()))(),
                    new Promise(r => setTimeout(() => r(null), files.length > 3 ? 3000 : 8000)),
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
            if (added % 10 === 0) saveLibrary({ sync: false, now: true })   // 大批匯入中途也存檔
        } catch (err) {
            console.error(err)
            const msg = err.message || String(err)
            failed.push([file.name, /not supported|zip|invalid|corrupt|unexpected|end of/i.test(msg)
                ? `檔案可能已損壞，或副檔名與實際格式不符（${msg}）` : msg])
        }
    }
    const stopped = stopImport
    stopImport = false
    $('#loading-stop').classList.add('hidden')
    loading(null)
    if (added) {
        saveLibrary({ now: true })
        renderLibrary()
    }
    const parts = [added && `已匯入 ${added} 本`, skipped && `${skipped} 本已在書架`, failed.length && `${failed.length} 本失敗`].filter(Boolean)
    if (failed.length) {
        openModal('匯入結果', `<p>${parts.join('・')}${stopped ? '（已手動停止）' : ''}</p>
            <p class="hint">以下檔案無法匯入：</p>
            ${failed.map(([n, why]) => `<p style="font-size:13px;margin:6px 0"><b>${esc(n)}</b><br><span class="muted">${esc(why)}</span></p>`).join('')}`)
    } else if (parts.length && (batch || added)) {
        toast(parts.join('・') + (stopped ? '（已停止）' : ''))
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
        r.openedAt = Date.now()   // 「最近閱讀」排序用；同步時兩邊取較新的，不動 updatedAt
        saveLibrary()
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
