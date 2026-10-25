import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('HTML inicial de la aplicación', () => {
  it('renderiza una portada útil sin APIs del navegador y con un único H1', () => {
    const html = renderToString(createElement(App))

    expect((html.match(/<h1\b/g) ?? [])).toHaveLength(1)
    expect(html).toContain('<h1 id="hero-title">')
    expect(html).toContain('Limpia archivos')
    expect(html).toContain('CSV y Excel.')
    expect(html).toContain('Importa un archivo, revisa el diagnóstico y elige qué limpiar.')
    expect(html).toContain('CSV, TXT o TSV:')
    expect(html).toContain('XLSX: hasta 10 MB')
    expect(html).toContain('Procesamiento local')
    expect(html).toContain('No subimos tus archivos')
  })
})
