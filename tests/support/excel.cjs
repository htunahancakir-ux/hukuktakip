const { ZipFile } = require('yazl');
const escape = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );
const column = (i) => (i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26));
async function zip(entries) {
  const archive = new ZipFile(),
    chunks = [];
  const done = new Promise((resolve, reject) => {
    archive.outputStream.on('data', (c) => chunks.push(c));
    archive.outputStream.on('error', reject);
    archive.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, content] of Object.entries(entries)) archive.addBuffer(Buffer.from(content), name);
  archive.end();
  return done;
}
async function excel(sheets, extra = {}) {
  const entries = {
    'xl/workbook.xml':
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets
        .map((s, i) => '<sheet name="' + escape(s.name || 'Sayfa' + (i + 1)) + '" r:id="r' + i + '"/>')
        .join('') +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships>' +
      sheets
        .map((s, i) => '<Relationship Id="r' + i + '" Target="worksheets/sheet' + i + '.xml"/>')
        .join('') +
      '</Relationships>',
  };
  sheets.forEach((sheet, index) => {
    entries['xl/worksheets/sheet' + index + '.xml'] =
      '<worksheet><sheetData>' +
      sheet.rows
        .map(
          (row, r) =>
            '<row r="' +
            (r + 1) +
            '">' +
            row
              .map((value, c) =>
                typeof value === 'number'
                  ? '<c r="' + column(c) + (r + 1) + '"><v>' + value + '</v></c>'
                  : '<c r="' +
                    column(c) +
                    (r + 1) +
                    '" t="inlineStr"><is><t>' +
                    escape(value) +
                    '</t></is></c>',
              )
              .join('') +
            '</row>',
        )
        .join('') +
      '</sheetData></worksheet>';
  });
  return { fileName: 'synthetic.xlsx', fileBase64: (await zip({ ...entries, ...extra })).toString('base64') };
}
module.exports = { excel, zip };
