const { isDeepStrictEqual } = require('node:util');
const fail = (code, message) => Object.assign(Error(message), { code, status: code });
function owner(input) {
  if (
    !['document', 'client'].includes(input?.ownerType) ||
    typeof input.ownerId !== 'string' ||
    !input.ownerId ||
    input.ownerId.length > 200
  )
    throw fail(400, 'Geçerli bir dosya veya müvekkil seçin.');
  return input.ownerType === 'document' ? 'docs' : 'clients';
}
function appendAttachment(state, input, user, allowed) {
  const collection = owner(input);
  if (!allowed(user, collection === 'clients' ? 'clients' : 'documents'))
    throw fail(403, 'Ek yükleme yetkiniz yok.');
  const file = input.attachment;
  if (
    !file ||
    typeof file.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(file.id) ||
    typeof file.name !== 'string' ||
    !file.name.trim() ||
    file.name.length > 255
  )
    throw fail(400, 'Geçersiz dosya bilgisi.');
  const match =
    typeof file.data === 'string' &&
    /^data:(application\/pdf|image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(file.data);
  if (!match || match[2].length % 4 || Buffer.from(match[2], 'base64').toString('base64') !== match[2])
    throw fail(400, 'PDF, PNG, JPEG veya WEBP dosyası seçin.');
  const limit = (collection === 'clients' ? 2 : 3) * 1024 * 1024;
  if (Buffer.from(match[2], 'base64').length > limit) throw fail(400, 'Dosya boyutu sınırını aşıyor.');
  const current = state.data['icrapro-v1'][collection].find((row) => row.id === input.ownerId);
  if (!current) throw fail(404, 'Kayıt bulunamadı.');
  const prior = (current.attachments || []).find((row) => row.id === file.id);
  if (prior) {
    if (!isDeepStrictEqual([prior.name, prior.data], [file.name, file.data]))
      throw fail(409, 'Bu ek numarası başka bir dosya için kullanılmış.');
    return { attachment: prior };
  }
  const next = structuredClone(state);
  const record = next.data['icrapro-v1'][collection].find((row) => row.id === input.ownerId);
  const attachment = {
    id: file.id,
    name: file.name,
    mime: match[1],
    kind: match[1] === 'application/pdf' ? 'powerOfAttorney' : 'photo',
    data: file.data,
    createdAt: new Date().toISOString(),
  };
  record.attachments = [...(record.attachments || []), attachment];
  return { next, attachment };
}
module.exports = { owner, appendAttachment };
