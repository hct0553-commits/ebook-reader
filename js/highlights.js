// 重點標示：以「章節內的文字位移」作為定位，跨裝置一致
// 一筆重點：{ id, section, start, end, text, color, note, chapter, createdAt, updatedAt, deleted }

export const COLORS = ['yellow', 'green', 'blue', 'pink']
export const COLOR_NAMES = { yellow: '黃', green: '綠', blue: '藍', pink: '粉紅' }

/** root 內，(node, offset) 之前的文字長度 */
export function textOffset(root, node, offset) {
    const r = document.createRange()
    r.setStart(root, 0)
    try { r.setEnd(node, offset) } catch { return 0 }
    return r.toString().length
}

/** 把選取範圍轉成 root 內的 [start, end) */
export function rangeToOffsets(root, range) {
    const startIn = root.contains(range.startContainer)
    const endIn = root.contains(range.endContainer)
    const total = root.textContent.length
    const start = startIn ? textOffset(root, range.startContainer, range.startOffset) : 0
    const end = endIn ? textOffset(root, range.endContainer, range.endOffset) : total
    return { start: Math.max(0, start), end: Math.min(total, end) }
}

/** 取出 [start, end) 的文字 */
export function textAt(root, start, end) {
    return root.textContent.slice(start, end)
}

/** 把 [start, end) 包上 <mark class="hl"> */
export function wrapHighlight(root, hl) {
    const { start, end } = hl
    if (!(end > start)) return []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const targets = []
    let pos = 0, node
    while ((node = walker.nextNode())) {
        const len = node.data.length
        const ns = pos, ne = pos + len
        if (len && ne > start && ns < end) targets.push([node, Math.max(0, start - ns), Math.min(len, end - ns)])
        pos = ne
        if (pos >= end) break
    }
    const marks = []
    for (const [textNode, s, e] of targets) {
        let n = textNode
        if (s > 0) n = n.splitText(s)
        if (e - s < n.data.length) n.splitText(e - s)
        // 跳過區塊之間純空白的文字節點，避免破壞表格等結構
        if (!n.data.trim()) continue
        const mark = document.createElement('mark')
        mark.className = 'hl' + (hl.note ? ' has-note' : '')
        mark.dataset.id = hl.id
        mark.dataset.color = hl.color
        n.parentNode.insertBefore(mark, n)
        mark.appendChild(n)
        marks.push(mark)
    }
    return marks
}

export function unwrapHighlight(root, id) {
    for (const m of root.querySelectorAll(`mark.hl[data-id="${CSS.escape(id)}"]`)) {
        const p = m.parentNode
        while (m.firstChild) p.insertBefore(m.firstChild, m)
        p.removeChild(m)
        p.normalize()
    }
}

export function updateHighlightMarks(root, hl) {
    for (const m of root.querySelectorAll(`mark.hl[data-id="${CSS.escape(hl.id)}"]`)) {
        m.dataset.color = hl.color
        m.classList.toggle('has-note', !!hl.note)
    }
}

export function applyHighlights(root, list) {
    // 先畫長的，讓短的重疊重點在內層（點擊時優先選到）
    const sorted = [...list].sort((a, b) => (b.end - b.start) - (a.end - a.start))
    for (const hl of sorted) wrapHighlight(root, hl)
}

export const newId = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

/** 依閱讀順序排序（未刪除） */
export const sortedHighlights = record =>
    Object.values(record?.highlights ?? {})
        .filter(h => !h.deleted)
        .sort((a, b) => a.section - b.section || a.start - b.start)
