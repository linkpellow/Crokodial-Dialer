/** Transparent Electron windows need an explicit document canvas for readable previews. */
export function previewSurface(html: string): string {
  return '<style>:root{color-scheme:light;background:#fff;color:#17212b}body{margin:0;background:#fff;color:#17212b}</style>' + html;
}
