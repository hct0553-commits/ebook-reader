// 本機測試用的靜態伺服器：node tools/serve.mjs [port]
// 之後用瀏覽器開 http://localhost:8080
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const port = Number(process.argv[2]) || 8080
const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf', '.epub': 'application/epub+zip', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

createServer(async (req, res) => {
    try {
        let path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
        if (path.endsWith('/')) path += 'index.html'
        const file = normalize(join(root, path))
        if (!file.startsWith(root)) { res.writeHead(403); return res.end() }
        if (!(await stat(file)).isFile()) throw new Error()
        res.writeHead(200, { 'Content-Type': types[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
        res.end(await readFile(file))
    } catch {
        res.writeHead(404); res.end('Not found')
    }
}).listen(port, () => console.log(`重點閱讀 Reader：http://localhost:${port}`))
