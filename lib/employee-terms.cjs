const crypto = require('node:crypto');

const TITLE = 'Çalışanlar İçin Gizlilik ve Kişisel Veri Güvenliği Sözleşmesi';
const DOMAIN = 'https://www.hanhukuktakip.com';
const DEFAULT_CONTROLLER = 'Han Hukuk (Av. Hasan Bahadır Patan)';
const ACCEPT_LABEL = 'Metni okudum ve kurallara uymayı taahhüt ediyorum';
const REQUIRED_MESSAGE = 'Çalışma alanına geçmek için güncel gizlilik sözleşmesini okuyup kabul edin.';
const versionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function draft(
  controllerName = DEFAULT_CONTROLLER,
  incidentContact = 'Av. Hasan Bahadır Patan veya büro yönetimi',
) {
  return {
    controllerName,
    sections: [
      {
        title: 'Kapsam',
        text: 'Bu sözleşme, yönetici, avukat ve yardımcı personel dahil yetkili kullanıcıların Han Hukuk Takip yazılımında veya görevlerini yürütürken eriştiği bilgileri kapsar. Kullanıcı hesapları, müvekkil ve dosya taraflarının bilgileri, dava ve icra evrakı, tahsilat ve muhasebe kayıtları, yazışmalar, meslek sırları ve iş sırları bu kapsamdadır.',
      },
      {
        title: 'Dosyalara erişim ve yetki sınırı',
        highlight: 'Sadece göreviniz için gerekli kayıtlara, size tanımlanan yetki ölçüsünde erişin.',
        text: 'Kendiniz, yakınlarınız veya başkaları için görev dışı sorgu yapmayın. Özel nitelikli kişisel veriler için belirlenen ek güvenlik ve erişim kurallarına uyun. Yardımcı personel kendisine verilen destek işleriyle sınırlı hareket eder.',
      },
      {
        title: 'Paylaşım ve kopyalama',
        highlight:
          'Yalnızca görev için gerekli veriyi, hukuka uygun olarak ve onaylı kanaldan paylaşır. İşin gereği ve tanımlı yetki bulunmadıkça ekran görüntüsü almaz, çıktı almaz ve veri indirmez. Dosya veya kişisel verileri kişisel e-posta, kişisel mesajlaşma hesabı, kişisel bulut hesabı ya da onaysız yapay zekâ araçlarına göndermez.',
        text: 'Bir evrakı, tutanağı, mesajı veya yedeği paylaşmadan önce alıcının kimliğini ve yetkisini doğrulayın. Kurumsal gönderim kanalları yalnızca büroca onaylanan işlemlerde ve yetkili alıcılar için kullanılır.',
      },
      {
        title: 'Hesap ve cihaz güvenliği',
        highlight: 'Şifrenizi başkasıyla paylaşmayın.',
        text: 'Yalnızca kendi hesabınızı ve büronun izin verdiği cihazları kullanın. Cihazdan ayrıldığınızda ekranı kilitleyin veya oturumu kapatın.',
      },
      {
        title: 'Büronun uygulayacağı tedbirler',
        text: 'Büro, yetkileri görevle sınırlar ve düzenli olarak gözden geçirir. Çalışanları veri güvenliği kuralları hakkında bilgilendirir. Giriş, çıkış, başarısız giriş, kayıt değişikliği, yedek indirme ve kabul kayıtlarına erişimi görevle sınırlar.',
      },
      {
        title: 'İhlal şüphesinin bildirilmesi',
        highlight:
          'Yanlış alıcıya gönderim, cihaz kaybı, yetkisiz erişim veya sızıntı şüphesini teyit beklemeden bildirin.',
        text: `Bildirim için ${incidentContact} ile doğrudan iletişim kurun. İlgili kayıtları koruyun. Kişisel veri içeren belgeleri yetkisiz kanaldan iletmeyin. Kişisel veri başvurularını ve resmî talepleri yetkili büro yönetimine gecikmeden bildirin.`,
      },
      {
        title: 'Görev değişikliği ve ayrılma',
        text: 'Görev değiştiğinde ihtiyaç kalmayan erişimler, iş ilişkisi veya görev sona erdiğinde ise ilgili iş erişimleri kaldırılır. Tahsis edilen cihazları, evrakı ve iş kayıtlarını teslim edin. Saklama yükümlülükleri ve delillerin korunması gözetilerek kalan kopyalar için büronun iade veya güvenli imha talimatına uyun.',
      },
      {
        title: 'Sır saklama ve kanuni haklar',
        text: 'Kişisel verileri hukuka aykırı açıklamama ve amacı dışında kullanmama yükümlülüğü görev sona erdikten sonra da sürer. İş ve meslek sırları, ilgili mevzuat ve korunması gereken menfaat ölçüsünde saklanır. Avukatların meslek sırrı yükümlülükleri, kanuni bildirimler ve yetkili mercilere başvuru hakları saklıdır.',
      },
      {
        title: 'Kabul ve yürürlük',
        text: 'Aykırılıklar olayın koşulları ve ilgili mevzuat çerçevesinde değerlendirilir. Büronun veri güvenliğine ilişkin kanuni yükümlülükleri saklıdır. Kanunen özel bir şekil aranmadığı hâllerde kullanıcı, kimliği doğrulanmış hesabından bu sürümü açıkça kabul ederek kurallara uyacağını taahhüt eder.',
      },
    ],
  };
}

function newRelease(input, issuedAt = new Date().toISOString()) {
  const version = String(input?.version || '').trim();
  const controllerName = String(input?.controllerName || '').trim();
  const sections = input?.sections;
  if (
    !versionPattern.test(version) ||
    !controllerName ||
    controllerName.length > 180 ||
    !Array.isArray(sections) ||
    !sections.length ||
    sections.length > 20
  )
    throw Object.assign(new Error('Belge sürümünü, veri sorumlusunu ve metni kontrol edin.'), { code: 400 });
  const clean = sections.map((section) => ({
    title: String(section?.title || '').trim(),
    text: String(section?.text || '').trim(),
    highlight: String(section?.highlight || '').trim(),
  }));
  if (
    clean.some(
      (section) =>
        !section.title ||
        section.title.length > 150 ||
        !section.text ||
        section.text.length > 5000 ||
        section.highlight.length > 2000,
    ) ||
    clean.reduce((size, section) => size + section.text.length + section.highlight.length, 0) > 40000
  )
    throw Object.assign(new Error('Belge bölümleri boş veya izin verilen uzunluğu aşıyor.'), { code: 400 });
  const document = { version, title: TITLE, controllerName, domain: DOMAIN, issuedAt, sections: clean };
  return { ...document, hash: digest(document) };
}

function currentRelease(state) {
  const terms = state.employeeTerms;
  return terms?.releases?.find((row) => row.version === terms.activeVersion) || null;
}

function currentNotice(state) {
  const terms = state.employeeTerms;
  return terms?.notices?.find((row) => row.version === terms.noticeVersion) || null;
}

function newNotice(input) {
  const version = String(input?.version || '').trim();
  const value = String(input?.url || '').trim();
  let url;
  try {
    url = new URL(value);
  } catch {}
  if (
    !versionPattern.test(version) ||
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    value.length > 1000
  )
    throw Object.assign(new Error('Aydınlatma için bir sürüm ve geçerli HTTPS bağlantısı girin.'), {
      code: 400,
    });
  const notice = { version, url: url.href };
  return { ...notice, hash: digest(notice) };
}

function acceptance(state, user, release = currentRelease(state)) {
  if (!release || !user) return null;
  return (
    state.employeeTerms?.acceptances?.find(
      (row) => row.accountId === user.id && row.version === release.version && row.hash === release.hash,
    ) || null
  );
}

function reminder(state, user, release = currentRelease(state)) {
  if (!release || !user) return null;
  return (
    state.employeeTerms?.reminders?.findLast(
      (row) => row.accountId === user.id && row.version === release.version && !row.seenAt,
    ) || null
  );
}

function requiresEmployeeTerms(state, user) {
  const release = currentRelease(state);
  // The platform's support account works under the platform agreement, not the office's terms.
  return Boolean(
    user && user.role !== 'ceo' && !user.platformSupport && release && !acceptance(state, user, release),
  );
}

function data(state) {
  return (state.employeeTerms ||= {
    activeVersion: null,
    releases: [],
    acceptances: [],
    notices: [],
    noticeEvents: [],
    reminders: [],
  });
}

function actor(user) {
  return { accountId: user.id, username: user.username, name: user.name, role: user.role };
}

module.exports = {
  ACCEPT_LABEL,
  REQUIRED_MESSAGE,
  DEFAULT_CONTROLLER,
  draft,
  newRelease,
  currentRelease,
  currentNotice,
  newNotice,
  acceptance,
  reminder,
  requiresEmployeeTerms,
  data,
  actor,
};
