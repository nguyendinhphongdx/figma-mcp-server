/**
 * Layer names in this server's files are frequently Vietnamese ("Vườn", "Trường bắn"), and people
 * type queries without diacritics. Folding marks away makes "truong ban" find "Trường bắn", which
 * is the difference between a search tool that gets used and one that does not.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/** Case- and diacritic-insensitive substring match. An empty needle matches everything. */
export function looseIncludes(haystack: string, needle: string): boolean {
  const folded = foldForSearch(needle);
  return folded.length === 0 || foldForSearch(haystack).includes(folded);
}
