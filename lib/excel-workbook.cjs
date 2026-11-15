const yauzl = require('yauzl');
const { SaxesParser } = require('saxes');
const MAX_FILE = 2 * 1024 * 1024,
  MAX_XML = 8 * 1024 * 1024,
  MAX_TOTAL = 24 * 1024 * 1024;
const bad = (message) => Object.assign(Error(message), { status: 400 });

async function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error) return reject(bad('Excel dosyası okunamadı. Geçerli bir .xlsx dosyası seçin.'));
        const files = new Map();
        let count = 0,
          total = 0,
          stopped = false;
        const fail = (error) => {
          if (stopped) return;
          stopped = true;
          zip.close();
          reject(error.status ? error : bad('Excel arşivi bozuk veya desteklenmiyor.'));
        };
        zip.on('error', fail);
        zip.on('end', () => {
          if (!stopped) resolve(files);
        });
        zip.on('entry', (entry) => {
          if (
            ++count > 200 ||
            entry.uncompressedSize > MAX_XML ||
            (total += entry.uncompressedSize) > MAX_TOTAL
          )
            return fail(bad('Excel dosyası çok büyük. Daha küçük bir dosya seçin.'));
          if (
            /vbaProject|externalLinks|embeddings|\.bin$/i.test(entry.fileName) ||
            entry.generalPurposeBitFlag & 1
          )
            return fail(bad('Makrolu, şifreli veya dış bağlantılı Excel dosyaları aktarılamaz.'));
          if (
            !/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(
              entry.fileName,
            )
          )
            return zip.readEntry();
          if (files.has(entry.fileName)) return fail(bad('Excel içinde yinelenen dosya adı var.'));
          zip.openReadStream(entry, (error, stream) => {
            if (error) return fail(error);
            let length = 0;
            const chunks = [];
            stream.on('error', fail);
            stream.on('data', (chunk) => {
              length += chunk.length;
              if (length > MAX_XML) {
                stream.destroy();
                fail(bad('Excel sayfası çok büyük.'));
              } else chunks.push(chunk);
            });
            stream.on('end', () => {
              if (!stopped) {
                files.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
                zip.readEntry();
              }
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

function xml(text) {
  if (typeof text !== 'string') throw bad('Excel dosyasında gerekli sayfalar eksik.');
  const root = { children: [] },
    stack = [root];
  let count = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => {
    throw bad('Excel XML tanımları desteklenmiyor.');
  });
  parser.on('error', () => {
    throw bad('Excel XML içeriği geçersiz.');
  });
  parser.on('opentag', (tag) => {
    if (++count > 120000 || stack.length > 32) throw bad('Excel içeriği çok büyük veya karmaşık.');
    const node = { name: tag.local, attrs: Object.create(null), text: '', children: [] };
    for (const attr of Object.values(tag.attributes)) node.attrs[attr.name] = attr.value;
    stack.at(-1).children.push(node);
    stack.push(node);
  });
  const textNode = (value) => {
    stack.at(-1).text += value;
  };
  parser.on('text', textNode);
  parser.on('cdata', textNode);
  parser.on('closetag', () => stack.pop());
  parser.write(text).close();
  return root;
}
const children = (node, name) => node?.children?.filter((n) => n.name === name) || [];
function all(node, name) {
  return (node.children || []).flatMap((n) => [...(n.name === name ? [n] : []), ...all(n, name)]);
}
const content = (node) => (node ? node.text + node.children.map(content).join('') : '');
const first = (node, name) => children(node, name)[0];

async function readWorkbook(input) {
  if (typeof input?.fileName !== 'string' || !/\.xlsx$/i.test(input.fileName) || input.fileName.length > 200)
    throw bad('Excel (.xlsx) dosyası seçin.');
  const data = input.fileBase64;
  if (
    typeof data !== 'string' ||
    data.length > Math.ceil(MAX_FILE / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw bad('Excel dosyası en fazla 2 MB olabilir.');
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length || buffer.length > MAX_FILE || buffer.toString('base64') !== data)
    throw bad('Excel dosyası geçersiz.');
  const files = await unzip(buffer),
    workbook = xml(files.get('xl/workbook.xml'));
  const rels = all(xml(files.get('xl/_rels/workbook.xml.rels')), 'Relationship');
  const shared = files.has('xl/sharedStrings.xml')
    ? all(xml(files.get('xl/sharedStrings.xml')), 'si').map((n) => all(n, 't').map(content).join(''))
    : [];
  const styles = files.has('xl/styles.xml') ? xml(files.get('xl/styles.xml')) : { children: [] };
  const formats = new Map(all(styles, 'numFmt').map((n) => [Number(n.attrs.numFmtId), n.attrs.formatCode]));
  const xfs = children(all(styles, 'cellXfs')[0], 'xf').map((n) => Number(n.attrs.numFmtId));
  const date1904 = ['1', 'true'].includes(all(workbook, 'workbookPr')[0]?.attrs.date1904);
  const sheets = all(workbook, 'sheet');
  if (!sheets.length || sheets.length > 20) throw bad('Excel en fazla 20 sayfa içerebilir.');
  if (
    sheets.some((s) => !s.attrs.name || s.attrs.name.length > 31) ||
    new Set(sheets.map((s) => s.attrs.name.toLocaleLowerCase('tr'))).size !== sheets.length
  )
    throw bad('Excel sayfa adı geçersiz veya yineleniyor.');
  let rowCount = 0;
  return sheets.map((sheet) => {
    const relationship = rels.find((r) => r.attrs.Id === sheet.attrs['r:id']);
    if (
      !relationship ||
      typeof relationship.attrs.Target !== 'string' ||
      relationship.attrs.TargetMode === 'External'
    )
      throw bad('Excel sayfa bağlantısı geçersiz.');
    const path = require('node:path').posix.normalize(
      relationship.attrs.Target.startsWith('/')
        ? relationship.attrs.Target.slice(1)
        : 'xl/' + relationship.attrs.Target,
    );
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) throw bad('Excel sayfası desteklenmiyor.');
    const rowNumbers = new Set();
    const rows = all(xml(files.get(path)), 'row')
      .map((row) => {
        if (
          !/^[1-9]\d{0,6}$/.test(row.attrs.r || '') ||
          Number(row.attrs.r) > 1048576 ||
          rowNumbers.has(row.attrs.r)
        )
          throw bad('Excel satır numarası geçersiz veya yineleniyor.');
        rowNumbers.add(row.attrs.r);
        const cells = Object.create(null);
        const cellColumns = new Set();
        if (children(row, 'c').length > 100) throw bad('Excel sayfası en fazla 100 sütun içerebilir.');
        for (const cell of children(row, 'c')) {
          if (!/^[A-Z]{1,2}[1-9]\d{0,6}$/.test(cell.attrs.r || '')) throw bad('Excel hücre adresi geçersiz.');
          const column = cell.attrs.r.replace(/\d/g, ''),
            raw = content(first(cell, 'v'));
          if (cell.attrs.r.slice(column.length) !== row.attrs.r || cellColumns.has(column))
            throw bad('Excel hücre adresi satırla uyuşmuyor veya yineleniyor.');
          cellColumns.add(column);
          let value =
            cell.attrs.t === 's'
              ? shared[Number(raw)]
              : cell.attrs.t === 'inlineStr'
                ? all(cell, 't').map(content).join('')
                : raw;
          if (value == null) throw bad('Excel metin hücresi okunamadı.');
          const format = xfs[Number(cell.attrs.s || 0)],
            code = (formats.get(format) || '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
          if (
            (!cell.attrs.t || cell.attrs.t === 'n') &&
            value &&
            ((format >= 14 && format <= 22) || /[yd]/i.test(code))
          ) {
            const serial = Number(value),
              stamp = (serial - (date1904 ? 24107 : 25569)) * 86400000;
            if (!Number.isFinite(stamp) || serial < 0 || serial > 2958465)
              throw bad('Excel tarihi geçersiz.');
            value = new Date(Math.round(stamp)).toISOString().slice(0, 10);
          } else if ((!cell.attrs.t || cell.attrs.t === 'n') && /^-?\d+(\.\d+)?$/.test(value)) {
            value = value.replace('.', ',');
          }
          if (String(value).length > 4000) throw bad('Bir Excel hücresi en fazla 4000 karakter olabilir.');
          if (value !== '') cells[column] = String(value);
        }
        return { row: Number(row.attrs.r), cells };
      })
      .filter((row) => Object.keys(row.cells).length);
    rowCount += rows.length;
    if (rowCount > 550)
      throw bad('Bir dosyada en fazla 500 veri satırı aktarabilirsiniz. Dosyayı bölerek yeniden yükleyin.');
    return { name: sheet.attrs.name, rows };
  });
}

async function makeTemplate(headers) {
  const zip = new (require('yazl').ZipFile)();
  const escape = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
    );
  const col = (i) => (i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26));
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    '[Content_Types].xml',
  );
  zip.addBuffer(
    Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    '_rels/.rels',
  );
  zip.addBuffer(
    Buffer.from(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Aktarım" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/workbook.xml',
  );
  zip.addBuffer(
    Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/_rels/workbook.xml.rels',
  );
  zip.addBuffer(
    Buffer.from(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">' +
        headers
          .map((s, i) => '<c r="' + col(i) + '1" t="inlineStr"><is><t>' + escape(s) + '</t></is></c>')
          .join('') +
        '</row></sheetData></worksheet>',
    ),
    'xl/worksheets/sheet1.xml',
  );
  const chunks = [];
  const output = new Promise((resolve, reject) => {
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  zip.end();
  return output;
}
module.exports = { readWorkbook, makeTemplate, MAX_FILE, bad };
