// Draws a PDF's pages onto canvases with Mozilla PDF.js (self-hosted in /_app/vendor/pdfjs/), so previews work
// where the browser's own viewer can't be embedded: Android, WeChat, and Chrome set to "Download PDFs".
// Pages are drawn as they scroll near the screen; PDF.js fetches only the byte ranges it needs.

const BASE = '/_app/vendor/pdfjs/';
// Pages are drawn wider than the screen so text stays sharp when pinch-zoomed on phones,
// and capped so a page stays well under iOS Safari's canvas size limit.
const MIN_PIXELS_WIDE = 1600;
const MAX_PIXELS_WIDE = 2400;
const MAX_PIXELS = 8e6;

export async function renderPdf(container, url) {
  const pdfjs = await import(`${BASE}pdf.min.js`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.js`;
  const doc = await pdfjs.getDocument({
    url,
    cMapUrl: `${BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}standard_fonts/`,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const { width, height } = page.getViewport({ scale: 1 });
    const box = document.createElement('div');
    box.className = 'pdf-page';
    box.style.aspectRatio = `${width} / ${height}`;
    box.dataset.page = String(number);
    pages.push({ page, box, number, width, height, drawn: false });
  }
  container.replaceChildren(...pages.map((item) => item.box));

  const draw = async (item) => {
    if (item.drawn) return;
    item.drawn = true;
    const screenPixels = item.box.clientWidth * (window.devicePixelRatio || 1);
    let pixelsWide = Math.min(Math.max(screenPixels, MIN_PIXELS_WIDE), MAX_PIXELS_WIDE);
    pixelsWide = Math.min(pixelsWide, Math.sqrt(MAX_PIXELS * item.width / item.height));
    const viewport = item.page.getViewport({ scale: pixelsWide / item.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await item.page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    // Keep an image instead of the canvas: iOS caps the memory all canvases on a page may use, while
    // images can be dropped and re-decoded by the browser. Images can also be long-pressed to save.
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) {
      item.box.replaceChildren(canvas);
      return;
    }
    const img = document.createElement('img');
    img.alt = '';
    img.src = URL.createObjectURL(blob);
    await img.decode().catch(() => {});
    item.box.replaceChildren(img);
    canvas.width = 0;
    canvas.height = 0;
  };

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      draw(pages[Number(entry.target.dataset.page) - 1]).catch(() => {});
    }
  }, { rootMargin: '600px 0px' });
  for (const item of pages) observer.observe(item.box);
  return doc.numPages;
}
