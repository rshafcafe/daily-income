// Client-side image compression. A phone photo (3-8 MB) becomes a ~200-400 KB
// JPEG that is still sharp enough for OCR, plus a tiny thumbnail for lists.
const MAX_SIDE = 1800;
const MAX_CHARS = 700000;   // keeps every image document well under Firestore's 1 MB limit
const THUMB_SIDE = 160;

async function decode(source) {
  if (source instanceof Blob && 'createImageBitmap' in window) {
    try { return await createImageBitmap(source, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  }
  const url = source instanceof Blob ? URL.createObjectURL(source) : source;
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    if (source instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

function draw(bitmap, maxSide, quality) {
  const w0 = bitmap.width || bitmap.naturalWidth;
  const h0 = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** source: File/Blob or data URL. Returns {data, thumb}. */
export async function compressImage(source) {
  const bitmap = await decode(source);
  try {
    let side = MAX_SIDE;
    let quality = 0.78;
    let data = draw(bitmap, side, quality);
    while (data.length > MAX_CHARS && side > 700) {
      side = Math.round(side * 0.85);
      quality = Math.max(0.5, quality - 0.06);
      data = draw(bitmap, side, quality);
    }
    return { data, thumb: draw(bitmap, THUMB_SIDE, 0.6) };
  } finally {
    bitmap.close?.();
  }
}

export function dataUrlParts(dataUrl) {
  const m = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  let ext = (m[1].split('/')[1] || 'jpg').toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  return { mime: m[1], base64: m[2], ext };
}
