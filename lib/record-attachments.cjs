const { isDeepStrictEqual } = require('node:util');
const fail = (code, message) => Object.assign(Error(message), { code, status: code });
function owner(input) {
  if (
    !['document', 'client', 'personnel'].includes(input?.ownerType) ||
    typeof input.ownerId !== 'string' ||
    !input.ownerId ||
    input.ownerId.length > 200
  )
    throw fail(400, 'Geçerli bir dosya, müvekkil veya personel seçin.');
  return input.ownerType === 'document' ? 'docs' : input.ownerType === 'personnel' ? 'personnel' : 'clients';
}
function appendAttachment(state, input, user, allowed) {
  const collection = owner(input);
  if (
    collection === 'personnel'
      ? !['ceo', 'admin'].includes(user?.role)
      : !allowed(user, collection === 'clients' ? 'clients' : 'documents')
  )
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
  if (input.part !== undefined) {
    const rows =
      collection === 'personnel' ? state.data['icrapro-personnel-v1'] : state.data['icrapro-v1'][collection];
    if (!rows.some((row) => row.id === input.ownerId)) throw fail(404, 'Kayıt bulunamadı.');
    const maximum = (collection === 'clients' ? 2 : 10) * 1024 * 1024;
    if (
      !Number.isInteger(input.part) ||
      !Number.isInteger(input.parts) ||
      input.parts < 1 ||
      input.parts > Math.ceil(((maximum * 4) / 3 + 256) / 524288) ||
      input.part < 0 ||
      input.part >= input.parts ||
      typeof file.data !== 'string' ||
      file.data.length > 524288
    )
      throw fail(400, 'Geçersiz dosya parçası.');
    const next = structuredClone(state);
    const uploads = (next.attachmentUploads ||= {});
    for (const [id, upload] of Object.entries(uploads)) if (upload.expires < Date.now()) delete uploads[id];
    const key = require('node:crypto')
      .createHash('sha256')
      .update(JSON.stringify([user.id, input.ownerType, input.ownerId, file.id]))
      .digest('hex');
    if (!uploads[key] && Object.values(uploads).filter((upload) => upload.actor === user.id).length >= 4)
      throw fail(400, 'Önce bekleyen dosya yüklemelerini tamamlayın.');
    const upload = (uploads[key] ||= {
      actor: user.id,
      expires: Date.now() + 3600000,
      name: file.name,
      parts: input.parts,
      chunks: [],
    });
    if (
      upload.parts !== input.parts ||
      upload.name !== file.name ||
      input.part > upload.chunks.length ||
      (upload.chunks[input.part] !== undefined && upload.chunks[input.part] !== file.data)
    )
      throw fail(409, 'Dosya parçaları uyuşmuyor. Yüklemeyi yeniden deneyin.');
    upload.chunks[input.part] = file.data;
    if (upload.chunks.length !== input.parts)
      return { next, attachment: { id: file.id, name: file.name }, partial: true };
    const data = upload.chunks.join('');
    delete uploads[key];
    const result = appendAttachment(
      next,
      { ownerType: input.ownerType, ownerId: input.ownerId, attachment: { ...file, data } },
      user,
      allowed,
    );
    return { ...result, next: result.next || next };
  }
  const match =
    typeof file.data === 'string' &&
    /^data:(application\/pdf|image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(file.data);
  if (!match || match[2].length % 4 || Buffer.from(match[2], 'base64').toString('base64') !== match[2])
    throw fail(400, 'PDF, PNG, JPEG veya WEBP dosyası seçin.');
  const limit = (collection === 'clients' ? 2 : 10) * 1024 * 1024;
  if (Buffer.from(match[2], 'base64').length > limit) throw fail(400, 'Dosya boyutu sınırını aşıyor.');
  const current = (
    collection === 'personnel' ? state.data['icrapro-personnel-v1'] : state.data['icrapro-v1'][collection]
  ).find((row) => row.id === input.ownerId);
  if (!current) throw fail(404, 'Kayıt bulunamadı.');
  const files =
    collection === 'personnel'
      ? (state.personnelAttachments || [])
          .filter((row) => row.personnelId === input.ownerId)
          .map((row) => row.attachment)
      : current.attachments || [];
  const prior = files.find((row) => row.id === file.id);
  if (prior) {
    if (!isDeepStrictEqual([prior.name, prior.data], [file.name, file.data]))
      throw fail(409, 'Bu ek numarası başka bir dosya için kullanılmış.');
    return { attachment: prior };
  }
  const next = structuredClone(state);
  const attachment = {
    id: file.id,
    name: file.name,
    mime: match[1],
    kind: match[1] === 'application/pdf' ? 'powerOfAttorney' : 'photo',
    data: file.data,
    createdAt: new Date().toISOString(),
  };
  if (collection === 'personnel')
    (next.personnelAttachments ||= []).push({
      id: 'personnel:' + input.ownerId + ':' + file.id,
      personnelId: input.ownerId,
      attachment,
    });
  else {
    const record = next.data['icrapro-v1'][collection].find((row) => row.id === input.ownerId);
    record.attachments = [...(record.attachments || []), attachment];
  }
  return { next, attachment };
}
module.exports = { owner, appendAttachment };
