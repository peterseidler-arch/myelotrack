import { readPdfItems } from './pdf-items.js';
import { parseMyChartItems } from './parse.js';

let pdfjsPromise;

/** Load pdf.js on first use only, so it never weighs on app start-up. */
function loadPdfjs() {
  pdfjsPromise ||= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return pdfjsPromise;
}

/** Positioned text items from a user-chosen PDF, read on this device. */
export async function readPdfFileItems(file) {
  const pdfjs = await loadPdfjs();
  return readPdfItems(pdfjs, new Uint8Array(await file.arrayBuffer()));
}

/**
 * Read a MyChart PDF chosen by the user and parse it — entirely on this
 * device. The file's bytes are never uploaded; only the parsed values are.
 *
 * @param {File} file
 * @returns {Promise<ReturnType<typeof parseMyChartItems> & { file: string }>}
 */
export async function readMyChartFile(file) {
  const pdfjs = await loadPdfjs();
  const items = await readPdfItems(pdfjs, new Uint8Array(await file.arrayBuffer()));
  return { file: file.name, ...parseMyChartItems(items) };
}
