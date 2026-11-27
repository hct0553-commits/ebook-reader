// Google Drive 同步
// 權限只用 drive.file：App 只能看到「自己建立的檔案」，看不到你 Drive 裡的其他檔案。
// Drive 結構：
//   EbookReader/
//     library.json      ← 書庫、閱讀進度、所有重點
//     <書名>.epub / .pdf ...  ← 書檔本身
import { GOOGLE_CLIENT_ID, DRIVE_FOLDER_NAME } from './config.js'

const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const LIB_NAME = 'library.json'

export class AuthError extends Error {}

export const getClientId = () => (localStorage.getItem('gdrive.clientId') || GOOGLE_CLIENT_ID || '').trim()
export const setClientId = id => {
    localStorage.setItem('gdrive.clientId', id.trim())
    tokenClient = null
}
export const isLinked = () => localStorage.getItem('gdrive.linked') === '1'

const readToken = () => {
    try { return JSON.parse(localStorage.getItem('gdrive.token')) } catch { return null }
}
export const hasValidToken = () => {
    const t = readToken()
    return !!t && t.exp - 60_000 > Date.now()
}
const token = () => {
    if (!hasValidToken()) throw new AuthError('需要重新登入 Google')
    return readToken().access_token
}

/* ---------- Google Identity Services ---------- */
let gisPromise, tokenClient, pending
export const loadGIS = () => gisPromise ??= new Promise((resolve, reject) => {
    if (globalThis.google?.accounts?.oauth2) return resolve()
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => { gisPromise = null; reject(new Error('無法載入 Google 登入元件（請確認網路）')) }
    document.head.append(s)
})

const initClient = () => {
    if (tokenClient) return tokenClient
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: getClientId(),
        scope: SCOPE,
        callback: resp => {
            if (resp.error) return pending?.reject(new Error(resp.error_description || resp.error))
            localStorage.setItem('gdrive.token', JSON.stringify({
                access_token: resp.access_token,
                exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
            }))
            localStorage.setItem('gdrive.linked', '1')
            pending?.resolve()
        },
        error_callback: err => pending?.reject(new Error(err?.type === 'popup_closed' ? '登入視窗已關閉' : (err?.message || '登入失敗'))),
    })
    return tokenClient
}

/** 需在使用者點擊時呼叫（會開啟 Google 登入視窗） */
export async function signIn() {
    if (!getClientId()) throw new Error('尚未設定 Google 用戶端 ID')
    if (!globalThis.google?.accounts?.oauth2) await loadGIS()
    return new Promise((resolve, reject) => {
        pending = { resolve, reject }
        initClient().requestAccessToken({ prompt: isLinked() ? '' : 'consent' })
    })
}

export function signOut() {
    const t = readToken()
    if (t && globalThis.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t.access_token, () => {})
    for (const k of ['gdrive.token', 'gdrive.linked', 'gdrive.folderId', 'gdrive.libId']) localStorage.removeItem(k)
}

/* ---------- REST helpers ---------- */
async function call(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token()}`, ...(opts.headers ?? {}) } })
    if (res.status === 401) {
        localStorage.removeItem('gdrive.token')
        throw new AuthError('Google 登入已過期')
    }
    if (!res.ok) {
        let msg = `${res.status}`
        try { msg += ' ' + ((await res.json()).error?.message ?? '') } catch { /* ignore */ }
        const err = new Error('Google Drive 錯誤：' + msg)
        err.status = res.status
        throw err
    }
    return res
}
const q = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

const multipart = (meta, content, mime) => {
    const boundary = 'ebr' + Math.random().toString(36).slice(2)
    const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
        `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, content, `\r\n--${boundary}--`,
    ])
    return { body, type: `multipart/related; boundary=${boundary}` }
}

export async function ensureFolder() {
    const cached = localStorage.getItem('gdrive.folderId')
    if (cached) {
        try {
            const f = await (await call(`${API}/files/${cached}?fields=id,trashed`)).json()
            if (!f.trashed) return cached
        } catch (e) { if (e instanceof AuthError) throw e }
    }
    const query = `name='${q(DRIVE_FOLDER_NAME)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    const list = await (await call(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive`)).json()
    let id = list.files?.[0]?.id
    if (!id) {
        const res = await call(`${API}/files?fields=id`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
        })
        id = (await res.json()).id
    }
    localStorage.setItem('gdrive.folderId', id)
    localStorage.removeItem('gdrive.libId')
    return id
}

async function findLibraryFile(folderId) {
    const cached = localStorage.getItem('gdrive.libId')
    if (cached) return cached
    const query = `name='${LIB_NAME}' and '${folderId}' in parents and trashed=false`
    const list = await (await call(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`)).json()
    const id = list.files?.[0]?.id ?? null
    if (id) localStorage.setItem('gdrive.libId', id)
    return id
}

export async function loadRemoteLibrary(folderId) {
    let id = await findLibraryFile(folderId)
    if (!id) return { id: null, data: { version: 1, books: {} } }
    try {
        const data = await (await call(`${API}/files/${id}?alt=media`)).json()
        return { id, data: data?.books ? data : { version: 1, books: {} } }
    } catch (e) {
        if (e.status === 404) {
            localStorage.removeItem('gdrive.libId')
            return loadRemoteLibrary(folderId)
        }
        throw e
    }
}

export async function saveRemoteLibrary(folderId, id, data) {
    const json = JSON.stringify(data)
    if (id) {
        await call(`${UPLOAD}/files/${id}?uploadType=media`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json,
        })
        return id
    }
    const { body, type } = multipart({ name: LIB_NAME, parents: [folderId], mimeType: 'application/json' }, json, 'application/json')
    const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': type }, body })
    const newId = (await res.json()).id
    localStorage.setItem('gdrive.libId', newId)
    return newId
}

/** 上傳書檔（可續傳上傳，適合大檔），回傳 Drive 檔案 ID */
export async function uploadBook(blob, name, folderId) {
    const mime = blob.type || 'application/octet-stream'
    const init = await call(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': mime,
            'X-Upload-Content-Length': String(blob.size),
        },
        body: JSON.stringify({ name, parents: [folderId] }),
    })
    const location = init.headers.get('Location')
    if (location) {
        const res = await fetch(location, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob })
        if (!res.ok) throw new Error(`上傳失敗（${res.status}）`)
        return (await res.json()).id
    }
    // 取不到 Location 時改用 multipart
    const { body, type } = multipart({ name, parents: [folderId] }, blob, mime)
    const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': type }, body })
    return (await res.json()).id
}

export async function downloadBook(fileId) {
    return (await call(`${API}/files/${fileId}?alt=media`)).blob()
}

export async function trashFile(fileId) {
    await call(`${API}/files/${fileId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
    })
}

/** 把 HTML 轉存成 Google 文件 */
export async function createGoogleDoc(name, html, folderId) {
    const { body, type } = multipart(
        { name, parents: [folderId], mimeType: 'application/vnd.google-apps.document' }, html, 'text/html; charset=UTF-8')
    const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`, { method: 'POST', headers: { 'Content-Type': type }, body })
    return res.json()
}

/* ---------- 合併兩份書庫（雙向同步） ---------- */
export function mergeLibraries(local, remote) {
    const out = { version: 1, books: {} }
    const A = local?.books ?? {}, B = remote?.books ?? {}
    for (const id of new Set([...Object.keys(A), ...Object.keys(B)])) {
        const a = A[id], b = B[id]
        if (!a || !b) { out.books[id] = structuredClone(a ?? b); continue }
        const newer = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b
        const older = newer === a ? b : a
        const m = structuredClone(newer)
        // 較新的一方還不知道 Drive 檔案 ID 時，沿用較舊一方（尚未丟到垃圾桶的）ID
        if (!m.driveFileId && older.driveFileId && !older.driveTrashed) {
            m.driveFileId = older.driveFileId
            m.driveTrashed = false
        }
        const opened = Math.max(a.openedAt || 0, b.openedAt || 0)
        if (opened) m.openedAt = opened
        const pa = a.progress, pb = b.progress
        m.progress = structuredClone((pa?.updatedAt || 0) >= (pb?.updatedAt || 0) ? pa : pb) ?? null
        // 封面設定獨立以 updatedAt 合併；同一張自訂圖片時，取已知 Drive 檔案 ID 的那一方
        const ca = a.cover, cb = b.cover
        let cv = (ca?.updatedAt || 0) >= (cb?.updatedAt || 0) ? ca : cb
        const co = cv === ca ? cb : ca
        if (cv?.kind === 'image' && !cv.driveFileId && co?.kind === 'image' && co.ver === cv.ver && co.driveFileId) cv = co
        m.cover = structuredClone(cv) ?? null
        const ha = a.highlights ?? {}, hb = b.highlights ?? {}
        m.highlights = {}
        for (const hid of new Set([...Object.keys(ha), ...Object.keys(hb)])) {
            const x = ha[hid], y = hb[hid]
            m.highlights[hid] = structuredClone(!x ? y : !y ? x : (x.updatedAt || 0) >= (y.updatedAt || 0) ? x : y)
        }
        out.books[id] = m
    }
    return out
}
