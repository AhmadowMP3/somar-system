import { utils, writeFile } from 'xlsx';

/** Download rows as an .xlsx file (right-to-left sheet). */
export function exportSheet(fileName: string, rows: Record<string, unknown>[]): void {
  const ws = utils.json_to_sheet(rows);
  const wb = utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  utils.book_append_sheet(wb, ws, 'Sheet1');
  writeFile(wb, `${fileName}.xlsx`);
}
