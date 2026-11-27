// Service Worker：離線可用。App 本體「網路優先」（確保更新），函式庫「快取優先」
const VERSION = 'ebr-v3'
const CORE = [
    './', 'index.html', 'manifest.webmanifest', 'css/app.css',
    'js/app.js', 'js/config.js', 'js/db.js', 'js/drive.js', 'js/export.js',
    'js/formats.js', 'js/highlights.js', 'js/reader.js', 'js/zip.js', 'js/t2s.js',
    'vendor/mammoth/mammoth.browser.min.js',
    'vendor/foliate-js/vendor/pdfjs/text_layer_builder.css',
    'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
]

self.addEventListener('install', e => {
    e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
        .then(() => self.clients.claim()))
})

self.addEventListener('fetch', e => {
    const req = e.request
    if (req.method !== 'GET') return
    const url = new URL(req.url)
    if (url.origin !== location.origin) return   // Google API 不快取

    const isVendor = url.pathname.includes('/vendor/')
    if (isVendor) {
        e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
            if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)) }
            return res
        })))
    } else {
        e.respondWith(fetch(req).then(res => {
            if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)) }
            return res
        }).catch(() => caches.match(req).then(hit => hit || caches.match('index.html'))))
    }
})
