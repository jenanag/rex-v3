export function codePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; count++) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return count;
}
