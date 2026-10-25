import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const canonical = 'https://dato-studio.pages.dev/'
const vite = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
})

let renderedApp
try {
  const { default: App } = await vite.ssrLoadModule('/src/App.tsx')
  renderedApp = renderToString(createElement(App))
} finally {
  await vite.close()
}

const outputPath = resolve(root, 'dist/index.html')
const html = await readFile(outputPath, 'utf8')
const rootPlaceholder = '<div id="root"></div>'
if (html.split(rootPlaceholder).length - 1 !== 1) {
  throw new Error('No se encontró exactamente un punto de montaje vacío en dist/index.html.')
}

const headingCount = (renderedApp.match(/<h1\b/g) ?? []).length
const requiredContent = [
  '<h1 id="hero-title">',
  'Limpia archivos',
  'CSV y Excel.',
  'Importa un archivo, revisa el diagnóstico y elige qué limpiar.',
  'CSV, TXT o TSV:',
  'XLSX: hasta 10 MB',
  'Procesamiento local',
  'No subimos tus archivos',
]
for (const text of requiredContent) {
  if (!renderedApp.includes(text)) throw new Error(`El HTML prerenderizado no contiene el contenido requerido: ${text}`)
}
if (headingCount !== 1) throw new Error(`El HTML prerenderizado debe tener un H1; se encontraron ${headingCount}.`)
if (!html.includes('<title>Limpiar archivos CSV y Excel online | Dato Studio</title>')) {
  throw new Error('El título SEO no está presente en dist/index.html.')
}
if (!html.includes('<link rel="canonical" href="https://dato-studio.pages.dev/" />')) {
  throw new Error(`La canonical no coincide con ${canonical}`)
}
if (!html.includes('Limpia archivos CSV y Excel en tu navegador.')) {
  throw new Error('La descripción meta no está presente en dist/index.html.')
}

const prerenderedHtml = html.replace(rootPlaceholder, `<div id="root">${renderedApp}</div>`)
await writeFile(outputPath, prerenderedHtml)
console.log(`Prerender listo: ${headingCount} H1, canonical ${canonical}`)
