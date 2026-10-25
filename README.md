# Dato Studio

Herramienta web para revisar y preparar archivos CSV y Excel. El procesamiento de los archivos ocurre en el navegador; no hay backend, analítica ni llamadas a servicios para leer o exportar archivos.

## Formatos y límites

- CSV, TXT y TSV: coma, punto y coma, tabulación o barra vertical; delimitador inferido como sugerencia y seleccionable. UTF-8 solamente.
- XLSX: selector de hoja con dimensiones; límite comprimido de 10 MiB, 256 entradas ZIP, máximo de 32 MiB por entrada y 64 MiB descomprimidos en total; además, 500.000 celdas en la hoja elegida. Se rechazan XLS, XLSM, libros cifrados, ZIP64 y ZIP con descriptor de datos.
- CSV: el límite de interfaz es 25 MB si el navegador no informa de memoria, y 50 MB cuando `navigator.deviceMemory` informa al menos 8 GB. Es una guía inicial por dispositivo, no una garantía de que otro navegador o pestaña disponga de esa memoria.
- Vista previa limitada a 30 filas. El worker conserva el documento fuente durante la sesión y devuelve solo resumen y filas de muestra a la interfaz. Parsing, diagnóstico y reglas se ejecutan en worker; la exportación CSV se construye por bloques. Cancelar termina el worker y descarta la sesión.

## Integridad de datos

- El documento original no se sobrescribe. Limpiezas se aplican como reglas reversibles derivadas del origen.
- CSV conserva valores como cadenas, incluidos ceros iniciales, y exporta BOM UTF-8. Filas de longitud irregular y encabezados vacíos/repetidos se mantienen; no se rellenan campos faltantes.
- XLSX conserva para celdas sin cambios su tipo básico, valor numérico/textual y formato numérico disponible. No se convierten fechas ni números automáticamente. Fórmulas no se ejecutan; se muestran como resultado almacenado o texto y se escriben como valores estáticos al exportar.
- Se avisa sobre celdas combinadas y enteros fuera del rango de precisión segura de JavaScript. Las celdas afectadas se marcan en la vista previa y se listan por referencia. XLSX usa números de JavaScript; si Excel ya redondeó un identificador numérico, no se puede recuperar. Los códigos fuente guardados como texto, incluidos los ceros iniciales, se conservan como texto.
- Exportar XLSX reconstruye un libro nuevo de una hoja con los datos tabulares. No es una copia del libro original: no se garantiza conservar estilos completos, fórmulas, gráficos, tablas dinámicas, macros, conexiones, vínculos ni otras funciones avanzadas.
- CSV advierte sobre valores que pueden convertirse en fórmulas en hojas de cálculo. La opción segura añade un apóstrofo de forma explícita y cambia ese contenido.
- La importación XLSX usa SheetJS Community Edition 0.20.3, Apache-2.0. Distribución y atribución:

  > SheetJS Community Edition — https://sheetjs.com/  
  > Copyright (C) 2012-present SheetJS LLC  
  > Licensed under the Apache License, Version 2.0.

## Rendimiento y validación de tamaños

El parser y los cálculos de resumen/reglas viven en un Web Worker; solo la muestra de 30 filas pasa a React. CSV se lee por bloques y su exportación forma un Blob a partir de bloques.

Antes de llamar a SheetJS, el worker recorre el directorio ZIP, limita entradas y tamaños, compara encabezados locales y centrales, valida CRC y descomprime cada entrada con `DecompressionStream` contando la salida real y cancelando al superar los topes. Así, los límites no dependen únicamente de los tamaños declarados por el archivo. SheetJS CE 0.20.3 lee normalmente todas las hojas; su límite de celdas se aplica después de abrir el contenedor. La guarda previa acota esa fase a 64 MiB declarados y comprobados en total y 32 MiB por entrada.

Para que SheetJS pueda reservar un buffer acotado a partir del tamaño local validado, se rechazan deliberadamente los ZIP que usan descriptores de datos (flag 3), además de ZIP64, entradas cifradas o divididas, métodos distintos de Store/Deflate, nombres sospechosos, solapamientos, tamaños inconsistentes y CRC incorrectos. Algunos XLSX válidos creados por herramientas que usan descriptores de datos podrían rechazarse; vuelve a guardarlos con Excel u otra herramienta compatible.

La comprobación de expansión se hace en streaming y detiene el lector al superar el límite, pero no demuestra inmunidad frente a todo archivo malicioso ni evita todo consumo excesivo de CPU/memoria del navegador o del descompresor nativo. Después de validar, SheetJS vuelve a descomprimir y modelar el libro dentro de los límites declarados; el XML y los objetos de celdas también consumen memoria. El límite de 10 MiB comprimidos y 500.000 celdas sigue siendo necesario.

Medición reproducible ejecutada con `node --expose-gc scripts/benchmark-csv-memory.mjs 10 25 50 100`, que crea un CSV temporal con filas únicas y elimina los fixtures al terminar. La prueba simula lectura, retención de filas, conteo de duplicados y diagnósticos en Node; **no es una prueba del worker de navegador**:

| CSV generado | Filas | Parseo | Diagnóstico | Pico RSS Node |
| ---: | ---: | ---: | ---: | ---: |
| 10 MB | 281.789 | 0,18 s | 0,33 s | 175 MB |
| 25 MB | 695.701 | 0,35 s | 0,84 s | 351 MB |
| 50 MB | 1.366.276 | 0,67 s | 1,76 s | 545 MB |
| 100 MB | 2.676.996 | 1,46 s | 3,48 s | 1.099 MB |

El pico cercano a 1,1 GB a 100 MB justifica no habilitar 100 MB como límite inicial: el consumo real depende del navegador, el dispositivo, las columnas y la pestaña.

La prueba de interfaz `npm run smoke:browser` usa Edge headless y fixtures temporales. En Edge 156 se verificaron cancelar y recuperarse, transformar/deshacer, exportar CSV con neutralización, elegir hoja XLSX, round-trip y aviso junto a una celda numérica imprecisa. CSV de 10, 25 y 50 MiB menos un byte se procesaron (281.789, 695.701 y 1.366.276 filas); exactamente 50 MiB se procesaron y 50 MiB + 1 byte y 100 MiB se rechazaron. XLSX comprimidos de 1,02, 5,02 y 9,93 MiB se procesaron; 10 MiB + 1 byte se rechazó. Fixtures ZIP/XLSX dañados o con extensiones incompatibles se rechazaron. También se comprobaron viewports móvil/escritorio, errores de consola y solicitudes externas durante esos flujos. Las pruebas unitarias ejercitan entradas comprimidas, CRC, descriptores y tamaños falsificados pequeños sin generar expansión masiva. Se simuló `deviceMemory=8` en la página para la ruta de 50 MiB. Un solo navegador no garantiza el rendimiento de otros dispositivos; no se generó un XLSX válido de exactamente 10 MiB.

## Desarrollo y pruebas

```sh
npm install
npm run dev
npm test
npm run build
npm run bench:csv -- 10 25 50 100
npm run preview
```

Vitest cubre delimitadores CSV, BOM, acentos, errores, vacíos, duplicados, cambios/deshacer, exportación CSV por bloques, límites, ZIP comprimido, límites de tamaño falsificados, CRC, entradas incompatibles, selección de hojas XLSX, metadatos y precisión de celdas, identificadores con ceros, fórmulas estáticas y round-trip de exportación. No hay script de lint. El smoke usa Edge con CDP directamente, sin instalar Playwright. La prueba observa peticiones de red durante los flujos ejercitados; no es una auditoría completa de privacidad.

La compilación para Cloudflare Pages usa `npm run build` y publica `dist`. La URL pública confirmada es `https://dato-studio.pages.dev/`; `index.html` declara esa dirección como canonical, `robots.txt` permite el rastreo y anuncia `sitemap.xml`, que por ahora contiene solo la página principal. No se ha afirmado que el sitio esté desplegado, verificado en Search Console ni indexado.

Para preparar Google Search Console, agrega la propiedad de prefijo `https://dato-studio.pages.dev/` y elige la verificación por etiqueta HTML. Cuando Google entregue la etiqueta `google-site-verification`, insértala sin cambiar su contenido en el `<head>` de `index.html`, en el espacio indicado, publica el cambio y luego pulsa **Verificar**. Después de verificar, envía `https://dato-studio.pages.dev/sitemap.xml` desde el informe **Sitemaps**. La propiedad no está verificada todavía y la solicitud de sitemap no garantiza indexación.
