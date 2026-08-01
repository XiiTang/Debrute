export function removeCanvasTextFontFaces(document: Document, faces: readonly FontFace[]): void {
  for (const face of faces) {
    document.fonts.delete(face);
  }
}
