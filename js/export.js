// 一鍵匯出閱讀重點：Word(.docx)、PDF（列印/另存為 PDF）、Markdown、純文字、Google 文件
import { makeZip } from './zip.js'
import { sortedHighlights, COLOR_NAMES } from './highlights.js'

const pad = n => String(n).padStart(2, '0')
export const fmtDate = ts => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const safeName = s => (s || '重點').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80)
export const exportFileName = (record, ext) => `${safeName(record.title)}_閱讀重點.${ext}`

const locText = (record, h) => record.format === 'pdf' ? `第 ${h.section + 1} 頁` : ''

/** 依章節分組 */
export function groups(record, { byChapter = true } = {}) {
    const list = sortedHighlights(record)
    if (!byChapter) return [{ chapter: '', items: list }]
    const out = []
    for (const h of list) {
        const ch = h.chapter || (record.format === 'pdf' ? `第 ${h.section + 1} 頁` : '')
        const last = out[out.length - 1]
        if (last && last.chapter === ch) last.items.push(h)
        else out.push({ chapter: ch, items: [h] })
    }
    return out
}

const header = record => {
    const n = sortedHighlights(record).length
    return { title: record.title || '未命名', author: record.author || '', count: n, date: fmtDate(Date.now()) }
}

/* ---------------- Markdown / 純文字 ---------------- */
export function toMarkdown(record, opts = {}) {
    const h = header(record)
    const lines = [`# ${h.title}`, '']
    if (h.author) lines.push(`作者：${h.author}  `)
    lines.push(`匯出時間：${h.date}　・　共 ${h.count} 則重點`, '')
    for (const g of groups(record, opts)) {
        if (g.chapter) lines.push(`## ${g.chapter}`, '')
        for (const it of g.items) {
            lines.push(...it.text.split('\n').map(l => `> ${l}`))
            if (opts.notes !== false && it.note) lines.push('>', ...it.note.split('\n').map((l, i) => `> ${i ? '' : '📝 筆記：'}${l}`))
            const loc = [locText(record, it), fmtDate(it.createdAt)].filter(Boolean).join('・')
            lines.push('', `<sub>${loc}</sub>`, '')
        }
    }
    return lines.join('\n')
}

export function toPlainText(record, opts = {}) {
    const h = header(record)
    const lines = [`《${h.title}》閱讀重點`]
    if (h.author) lines.push(`作者：${h.author}`)
    lines.push(`共 ${h.count} 則・${h.date}`, '')
    for (const g of groups(record, opts)) {
        if (g.chapter) lines.push(`【${g.chapter}】`)
        for (const it of g.items) {
            lines.push(`● ${it.text}`)
            if (opts.notes !== false && it.note) lines.push(`  筆記：${it.note}`)
        }
        lines.push('')
    }
    return lines.join('\n')
}

/* ---------------- HTML（列印成 PDF / Google 文件） ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const nl2br = s => esc(s).replace(/\n/g, '<br>')
const FILL = { yellow: '#fff8cc', green: '#e3f6e5', blue: '#e1eeff', pink: '#ffe3ef' }
const BAR = { yellow: '#ffd600', green: '#4cc85a', blue: '#4696ff', pink: '#ff5ca0' }

export function toPrintHTML(record, opts = {}) {
    const h = header(record)
    let html = `<h1>${esc(h.title)}</h1><div class="p-meta">${h.author ? esc(h.author) + '　・　' : ''}共 ${h.count} 則重點　・　${h.date}</div>`
    for (const g of groups(record, opts)) {
        if (g.chapter) html += `<h2>${esc(g.chapter)}</h2>`
        for (const it of g.items) {
            html += `<div class="p-hl c-${it.color}">${nl2br(it.text)}`
            if (opts.notes !== false && it.note) html += `<div class="p-note">📝 ${nl2br(it.note)}</div>`
            const loc = [locText(record, it), fmtDate(it.createdAt)].filter(Boolean).join('・')
            html += `<div class="p-loc">${esc(loc)}</div></div>`
        }
    }
    return html
}

/** Google 文件匯入用：全部使用行內樣式 */
export function toDocsHTML(record, opts = {}) {
    const h = header(record)
    let html = `<html><head><meta charset="utf-8"></head><body style="font-family:Arial">`
    html += `<h1>${esc(h.title)}</h1><p style="color:#666">${h.author ? esc(h.author) + '　・　' : ''}共 ${h.count} 則重點　・　${h.date}</p>`
    for (const g of groups(record, opts)) {
        if (g.chapter) html += `<h2 style="color:#2f5d50">${esc(g.chapter)}</h2>`
        for (const it of g.items) {
            html += `<p style="background-color:${FILL[it.color]};border-left:4px solid ${BAR[it.color]};padding:4px 8px">${nl2br(it.text)}</p>`
            if (opts.notes !== false && it.note) html += `<p style="color:#444;margin-left:16px">📝 ${nl2br(it.note)}</p>`
            const loc = [locText(record, it), fmtDate(it.createdAt)].filter(Boolean).join('・')
            html += `<p style="color:#999;font-size:9pt;margin-left:16px">${esc(loc)}</p>`
        }
    }
    return html + '</body></html>'
}

export function printPDF(record, opts = {}) {
    const area = document.getElementById('print-area')
    area.innerHTML = toPrintHTML(record, opts)
    const oldTitle = document.title
    document.title = exportFileName(record, 'pdf').replace(/\.pdf$/, '') // 多數瀏覽器以此作為預設檔名
    const done = () => { document.title = oldTitle; area.innerHTML = ''; window.removeEventListener('afterprint', done) }
    window.addEventListener('afterprint', done)
    window.print()
    setTimeout(() => { if (document.title !== oldTitle) document.title = oldTitle }, 60000)
}

/* ---------------- Word (.docx) ---------------- */
// 移除 XML 不允許的控制字元
const xmlEsc = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const run = (text, { bold, italic, color, size = 22 } = {}) => {
    const rpr = `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft JhengHei" w:cs="Calibri"/>` +
        (bold ? '<w:b/><w:bCs/>' : '') + (italic ? '<w:i/><w:iCs/>' : '') +
        (color ? `<w:color w:val="${color}"/>` : '') + `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`
    return String(text ?? '').split('\n').map((line, i) =>
        `<w:r>${rpr}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r>`).join('')
}

const para = (runs, { bar, fill, after = 120, before = 0, indent = 0, keepNext = false, outline = null, line = 300 } = {}) =>
    `<w:p><w:pPr>` +
    (keepNext ? '<w:keepNext/>' : '') +
    (bar ? `<w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="${bar}"/></w:pBdr>` : '') +
    (fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '') +
    `<w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="auto"/>` +
    (indent ? `<w:ind w:left="${indent}"/>` : '') +
    (outline != null ? `<w:outlineLvl w:val="${outline}"/>` : '') +
    `</w:pPr>${runs}</w:p>`

export function toDocx(record, opts = {}) {
    const h = header(record)
    let body = para(run(h.title, { bold: true, size: 40 }), { after: 80, outline: 0 })
    body += para(run(`${h.author ? h.author + '　・　' : ''}共 ${h.count} 則重點　・　${h.date}`, { color: '777777', size: 20 }), { after: 280 })
    for (const g of groups(record, opts)) {
        if (g.chapter) body += para(run(g.chapter, { bold: true, color: '2F5D50', size: 28 }), { before: 240, after: 120, keepNext: true, outline: 1 })
        for (const it of g.items) {
            const bar = BAR[it.color].slice(1).toUpperCase(), fill = FILL[it.color].slice(1).toUpperCase()
            body += para(run(it.text, { size: 22 }), { bar, fill, after: 40, indent: 160, line: 340 })
            if (opts.notes !== false && it.note)
                body += para(run('📝 筆記：', { bold: true, color: '555555', size: 20 }) + run(it.note, { color: '444444', size: 20 }), { indent: 360, after: 40 })
            const loc = [locText(record, it), fmtDate(it.createdAt)].filter(Boolean).join('・')
            body += para(run(loc, { color: '999999', size: 16 }), { indent: 360, after: 200 })
        }
    }
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    const files = [
        { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
        { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
        { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>` },
        { name: 'word/document.xml', data: doc },
        { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEsc(h.title)} 閱讀重點</dc:title><dc:creator>重點閱讀 Reader</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>` },
    ]
    return makeZip(files, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
}

/* ---------------- 交付檔案：手機用分享面板，電腦直接下載 ---------------- */
const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform))

/** 必須在使用者點擊事件中「同步」呼叫（iOS 的分享限制） */
export function deliver(blob, filename) {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
    if (isMobile() && navigator.canShare?.({ files: [file] })) {
        return navigator.share({ files: [file], title: filename }).then(() => 'shared')
            .catch(e => e?.name === 'AbortError' ? 'cancelled' : downloadBlob(blob, filename))
    }
    return Promise.resolve(downloadBlob(blob, filename))
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
    return 'downloaded'
}

export { COLOR_NAMES }
