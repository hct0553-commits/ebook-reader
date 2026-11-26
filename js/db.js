// IndexedDB：書檔、封面與書庫資料（含重點、進度）存放在本機
const DB_NAME = 'ebook-reader'
const DB_VERSION = 1
let dbPromise

const open = () => dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
        const db = req.result
        for (const name of ['files', 'covers', 'kv'])
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
})

const tx = async (store, mode, fn) => {
    const db = await open()
    return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        t.oncomplete = () => resolve(req?.result)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
    })
}

export const get = (store, key) => tx(store, 'readonly', s => s.get(key))
export const put = (store, key, value) => tx(store, 'readwrite', s => s.put(value, key))
export const del = (store, key) => tx(store, 'readwrite', s => s.delete(key))
export const keys = store => tx(store, 'readonly', s => s.getAllKeys())

// 請求永久儲存，避免瀏覽器（特別是 iOS Safari）自動清除
export const persist = () => navigator.storage?.persist?.().catch(() => {})
