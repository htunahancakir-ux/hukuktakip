const path = require('node:path');
const PDFDocument = require('pdfkit');

const formatDate = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'short' });
const amount = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' });
const font = path.join(__dirname, 'fonts', 'NotoSans-Latin.ttf');

function date(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? formatDate.format(parsed) : 'Belirtilmedi';
}
function safeName(value) {
  return (
    String(value || 'evrak')
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 100) || 'evrak'
  );
}

function storedMedia(data, name, image) {
  const match = /^data:(application\/pdf|image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(
    String(data || ''),
  );
  if (!match || match[2].length > 4 * 1024 * 1024 + 4 || image !== match[1].startsWith('image/'))
    throw new Error('Evrak eki geçersiz.');
  const mime = match[1];
  const bytes = Buffer.from(match[2], 'base64');
  const expected =
    mime === 'application/pdf'
      ? Buffer.from('%PDF-')
      : mime === 'image/png'
        ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        : Buffer.from([255, 216, 255]);
  if (!bytes.subarray(0, expected.length).equals(expected)) throw new Error('Evrak eki biçimi geçersiz.');
  const suffix = mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : '.jpg';
  const stem = safeName(name).replace(/\.[a-z0-9]{1,5}$/i, '');
  return { name: stem + suffix, mime, bytes };
}

async function generatedPdf({ kind, doc, client, firm, event }) {
  const titles = { receipt: 'Evrak Teslim Tutanağı', collection: 'Tahsilat Makbuzu', release: 'İbraname' };
  const title = titles[kind];
  if (!title) throw new Error('Bilinmeyen belge türü.');
  const pdf = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Title: title, Author: firm?.legalName || firm?.name || 'Han Hukuk' },
  });
  const pieces = [];
  const bytes = new Promise((resolve, reject) => {
    pdf.on('data', (part) => pieces.push(part));
    pdf.on('error', reject);
    pdf.on('end', () => resolve(Buffer.concat(pieces)));
  });
  try {
    pdf
      .font(font)
      .fillColor('#183b4b')
      .fontSize(11)
      .text(firm?.legalName || firm?.name || 'Han Hukuk');
    pdf.moveDown(0.6).fontSize(23).text(title);
    pdf.moveDown(0.45).strokeColor('#c3a36e').lineWidth(1).moveTo(48, pdf.y).lineTo(547, pdf.y).stroke();
    pdf.moveDown(1.4);
    const field = (label, value) => {
      pdf.fillColor('#506578').fontSize(9).text(label);
      pdf
        .fillColor('#172b3a')
        .fontSize(11)
        .text(String(value ?? 'Belirtilmedi').slice(0, 2000));
      pdf.moveDown(0.48);
    };
    field('Föy numarası', doc.number);
    field('Borçlu', doc.debtor);
    field('Müvekkil / Alacaklı', client?.tradeName || client?.name);
    if (kind === 'receipt') {
      field('Evrak türü / Referans', [doc.docType, doc.serial].filter(Boolean).join(' / '));
      field('Kabul tarihi', date(doc.created));
      field('Vade', date(doc.due));
      field('Tutar', amount.format(Number(doc.amount || 0)));
      field('Evrak aslı', doc.originalDocument);
      if (doc.phone1 || doc.phone2) field('Telefon', [doc.phone1, doc.phone2].filter(Boolean).join(' / '));
      if (doc.address) field('Adres', [doc.address, doc.district, doc.city].filter(Boolean).join(' / '));
      field('Teslim eden', doc.deliveredBy);
      field('Teslim alan', doc.receivedBy);
      if (doc.notes) field('Kabul notu', doc.notes);
      pdf
        .moveDown()
        .fontSize(10)
        .text('Teslim eden imza: __________________     Teslim alan imza: __________________');
    } else if (kind === 'collection') {
      field('Makbuz numarası', event.id);
      field('Tahsilat tarihi', date(event.date));
      if (doc.identity) field('TC / Vergi numarası', doc.identity);
      field('Tahsil edilen tutar', amount.format(event.amount / 100));
      field('Kasa / banka', event.accountName);
      if (event.note) field('Açıklama / Dekont no', event.note);
    } else {
      field('Takip tarihi', date(doc.trackingDate || doc.created));
      field('Ödemenin tamamlandığı tarih', date(doc.closedDate));
      pdf
        .moveDown(0.3)
        .fontSize(11)
        .text(
          `Alacaklı ${client?.tradeName || client?.name || 'firmaya'} için ${date(doc.closedDate)} tarihinde ödeme tamamlandığından, ${date(doc.trackingDate || doc.created)} takip tarihli ${doc.number || ''} numaralı dosyada borç kalmamıştır.`,
        );
    }
    pdf.moveDown().fontSize(9).fillColor('#506578').text('Bu çıktı elektronik imza içermez.');
    pdf.end();
  } catch (error) {
    pdf.destroy(error);
  }
  const result = await bytes;
  return { name: safeName(doc.number) + '-' + kind + '.pdf', mime: 'application/pdf', bytes: result };
}

async function batchPdf({ docs, clients, firm }) {
  const pdf = new PDFDocument({ size: 'A4', margin: 48 });
  const parts = [];
  const bytes = new Promise((resolve, reject) => {
    pdf.on('data', (part) => parts.push(part));
    pdf.on('error', reject);
    pdf.on('end', () => resolve(Buffer.concat(parts)));
  });
  try {
    pdf
      .font(font)
      .fillColor('#183b4b')
      .fontSize(11)
      .text(firm?.legalName || firm?.name || 'Han Hukuk');
    pdf.moveDown().fontSize(22).text('Teslim Tesellüm Tutanağı');
    pdf
      .moveDown()
      .fontSize(11)
      .text('Evrak adedi: ' + docs.length)
      .moveDown();
    let total = 0;
    docs.forEach((doc, index) => {
      const client = clients.find((row) => row.id === doc.client);
      total += Number(doc.amount || 0);
      pdf
        .fillColor('#183b4b')
        .fontSize(11)
        .text(`${index + 1}. ${doc.number || 'Evrak'} / ${doc.docType || ''}`);
      pdf
        .fillColor('#334f65')
        .fontSize(10)
        .text(
          [client?.name, doc.debtor, amount.format(Number(doc.amount || 0)), 'Kabul: ' + date(doc.created)]
            .filter(Boolean)
            .join(' / '),
        )
        .moveDown(0.6);
    });
    pdf.fontSize(11).text('Toplam tutar: ' + amount.format(total));
    pdf.moveDown().fontSize(9).text('Bu çıktı elektronik imza içermez.');
    pdf.end();
  } catch (error) {
    pdf.destroy(error);
  }
  return { name: 'teslim-tesellum-tutanagi.pdf', mime: 'application/pdf', bytes: await bytes };
}

async function renderWhatsAppMedia(media) {
  if (media.kind === 'file') return storedMedia(media.doc.fileData, media.doc.fileName, false);
  if (media.kind === 'photo') return storedMedia(media.doc.photoData, media.doc.photoFileName, true);
  if (media.kind === 'clientAttachment')
    return storedMedia(
      media.attachment.data,
      media.attachment.name,
      media.attachment.data.startsWith('data:image/'),
    );
  if (media.kind === 'batchReceipt') return batchPdf(media);
  return generatedPdf(media);
}

module.exports = { renderWhatsAppMedia };
