/**
 * Service Worker —— 让游戏可离线、可安装（v1.3.17）
 *
 * 缓存策略：
 * - **导航请求**（打开页面）：network-first —— 部署后立刻拿到新 HTML；断网时回落缓存
 * - **其他同源 GET**（构建产物都带 hash）：cache-first —— 命中即用，未命中再拉并缓存
 *
 * 为什么 cache-first 不会拿到过期的同名文件：`vite build` 的产物名里带内容 hash
 * （`index-XXXX.js`），HTML 是 network-first 拿最新的，引用的自然是最新 hash；
 * 旧 hash 的文件留在缓存里无害，`activate` 时会把其它版本的整体清掉。
 *
 * 注意：本地 `127.0.0.1` / `localhost` 上**不注册**（见 `src/main.ts`）——
 * 否则 e2e 与本地预览会读到缓存里的旧产物。
 */
const CACHE = 'tractor-v1'

/** 预缓存「应用外壳」：断网时至少能把页面拉起来 */
const SHELL = ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

/** 只缓存成功响应；失败（404/500）不入缓存 */
const putIfOk = (req, res) => {
  if (res && res.ok) caches.open(CACHE).then((cache) => cache.put(req, res.clone())).catch(() => {})
  return res
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin) return

  // ① 页面导航：先网络，失败回落缓存（离线时也能打开）
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => putIfOk(req, res))
        .catch(() =>
          caches.match('/index.html').then((hit) => hit || caches.match('/') || Response.error()),
        ),
    )
    return
  }

  // ② 静态资源：缓存优先，未命中再拉
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => putIfOk(req, res))),
  )
})
