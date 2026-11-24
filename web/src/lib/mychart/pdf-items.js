/**
 * Flatten a PDF's text into positioned items for parse.js: `{ str, x, y }` in
 * points, `y` top-down and accumulated across pages so a component that
 * straddles a page break still reads in order.
 *
 * `pdfjs` is injected (the browser build in the app, the legacy build in Node
 * scripts) so this stays environment-neutral.
 *
 * @param {object} pdfjs - a pdfjs-dist module
 * @param {Uint8Array} data - the PDF bytes
 * @returns {Promise<{ str: string, x: number, y: number }[]>}
 */
export async function readPdfItems(pdfjs, data) {
  // isEvalSupported: false — never let a crafted PDF reach `eval`.
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const items = [];
  let offset = 0;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        items.push({
          str: it.str,
          x: it.transform[4],
          y: offset + (height - it.transform[5]),
        });
      }
      offset += height;
    }
  } finally {
    await doc.destroy();
  }
  return items;
}
