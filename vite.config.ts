import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import pkg from './package.json'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * 修复 Vite 5 在 Windows 上路径大小写不一致时 HTML inline CSS/script proxy
 * 失效的 bug（也兼容 URL-encode 的非 ASCII 路径）。
 *
 * 根因：Vite 在 HTML transform 阶段注册 htmlProxyMap 时，key 由
 * `id.replace(normalizePath(config.root), "")` 计算。但 Rollup 在解析
 * import 语句时返回的路径可能和 config.root 的盘符大小写不一致
 * （如 `D:/...` vs `d:/...`），导致 replace 不匹配，url 保留了完整路径
 * 而非相对路径 `/index.html` ⇒ "No matching HTML proxy module found"。
 * 同理，css-post 插件用 getHash(cleanUrl(id)) 算 hash 时，大小写/编码
 * 不一致也会导致 generateBundle 阶段查 htmlProxyResult 失败。
 *
 * 修法：在 configResolved 中 patch 两个内部插件的 load/transform 钩子，
 * 把 html-proxy ID 的文件路径部分统一到 config.root 的大小写。
 */
function fixHtmlProxyPathMismatch(): Plugin {
  return {
    name: 'fix-html-proxy-path',
    configResolved(config) {
      const root = config.root
      const rootLower = root.toLowerCase()

      /** 把 html-proxy ID 的文件路径部分统一到 config.root 的大小写。 */
      const normalizeProxyId = (id: string): string => {
        if (!id.includes('?html-proxy')) return id
        const qIdx = id.indexOf('?')
        if (qIdx <= 0) return id
        let filePath = id.slice(0, qIdx)
        const query = id.slice(qIdx)
        // 先 decode（Rollup 可能 URL-encode 了非 ASCII 路径）
        try {
          const decoded = decodeURIComponent(filePath)
          if (decoded !== filePath) filePath = decoded
        } catch { /* ignore */ }
        // 大小写不敏感地替换 root 前缀
        if (filePath.toLowerCase().startsWith(rootLower)) {
          return root + filePath.slice(root.length) + query
        }
        return id
      }

      const htmlProxy = config.plugins.find((p) => p.name === 'vite:html-inline-proxy')
      if (htmlProxy?.load) {
        const origLoad = htmlProxy.load as unknown as
          | ((this: any, id: string) => any)
          | { handler: (this: any, id: string) => any }
        const callOrig = (ctx: any, id: string) =>
          typeof origLoad === 'function'
            ? origLoad.call(ctx, id)
            : origLoad.handler.call(ctx, id)
        htmlProxy.load = function (this: any, id: string) {
          return callOrig(this, normalizeProxyId(id))
        }
      }

      const cssPost = config.plugins.find((p) => p.name === 'vite:css-post')
      if (cssPost?.transform) {
        const origTransform = cssPost.transform as unknown as
          | ((this: any, code: string, id: string) => any)
          | { handler: (this: any, code: string, id: string) => any }
        const callOrig = (ctx: any, code: string, id: string) =>
          typeof origTransform === 'function'
            ? origTransform.call(ctx, code, id)
            : origTransform.handler.call(ctx, code, id)
        cssPost.transform = function (this: any, code: string, id: string) {
          return callOrig(this, code, normalizeProxyId(id))
        }
      }
    },
  }
}

export default defineConfig({
  // 相对路径，产物可放任意子目录（含 file:// 直接打开）
  base: './',
  // 版本号在构建时内联（单一来源 = package.json），运行期零依赖
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@ai': r('./src/ai'),
      '@app': r('./src/app'),
      '@ui': r('./src/ui'),
      '@audio': r('./src/audio'),
    },
  },
  plugins: [fixHtmlProxyPathMismatch()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    open: false,
  },
})
