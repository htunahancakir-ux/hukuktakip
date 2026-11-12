// The purchased user count, enforced where accounts are created or switched back on.
// Only an increase past the limit is refused: an office that shrank its plan can still edit,
// deactivate and rename the users it already has.
// The platform's support account (remote support access) is not a purchased user.
const activeUsers = (state) =>
  (state?.users || []).filter((user) => user.active !== false && !user.platformSupport).length;

function assertWithinUserLimit(limit, before, after, fail) {
  if (!Number.isInteger(limit)) return;
  const now = activeUsers(after);
  if (now > limit && now > activeUsers(before))
    throw fail(
      409,
      `Satın alınan kullanıcı sayısına (${limit}) ulaşıldı. Yeni kullanıcı eklemek veya pasif bir kullanıcıyı açmak için destek ekibiyle iletişime geçin.`,
    );
}

module.exports = { assertWithinUserLimit, activeUsers };
