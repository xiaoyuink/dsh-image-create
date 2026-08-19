import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('..', import.meta.url))
const cssPath = `${dir}lib/client/style.css`
const jsPath = `${dir}lib/client/index.cjs`

let css
try {
  css = readFileSync(cssPath, 'utf8')
} catch {
  console.warn('[inline-css] 未找到 style.css，跳过')
  process.exit(0)
}

const js = readFileSync(jsPath, 'utf8')

// dsh 的 client-modules 通过 claimStyles() 收集带 data-plugin 的 <style>，
// 与官方插件（vision）同款：factory 执行时注入 style 标签。
const injection = `;(function(){try{var e=document.createElement("style");e.setAttribute("data-plugin","@xiaoyuink/dsh-image-create");e.textContent=${JSON.stringify(css)};(document.head||document.documentElement).appendChild(e);}catch(_){}})();`

const anchor = 'Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });'
const index = js.indexOf(anchor)
if (index === -1) throw new Error('[inline-css] client bundle 中找不到注入锚点')

const next = js.indexOf('\n', index)
const out = js.slice(0, next + 1) + injection + '\n' + js.slice(next + 1)
writeFileSync(jsPath, out)
rmSync(cssPath)
console.log(`[inline-css] 已内联 ${css.length} 字符 css 进 client bundle`)
