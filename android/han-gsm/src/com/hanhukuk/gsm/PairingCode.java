package com.hanhukuk.gsm;

import java.net.URI;
import java.util.Locale;
import java.util.regex.Pattern;

final class PairingCode {
    private static final String DEFAULT_ORIGIN = "https://www.hanhukuktakip.com";
    private static final Pattern CODE = Pattern.compile("[A-Za-z0-9_.-]{1,100}\\.[A-Za-z0-9_-]{16}");
    private static final Pattern COPY_SPACING = Pattern.compile("[\\s\\p{Z}\\p{Cf}]");

    final String origin;
    final String value;

    private PairingCode(String origin, String value) {
        this.origin = origin;
        this.value = value;
    }

    static PairingCode parse(String input) {
        String text = COPY_SPACING.matcher(input).replaceAll("");
        int separator = text.lastIndexOf('/');
        String value = text.substring(separator + 1);
        if (!CODE.matcher(value).matches()) {
            throw new IllegalArgumentException("Kod eksik veya biçimi geçersiz. HAN Hukuk’ta Kodu kopyala’ya dokunun.");
        }
        if (separator < 0) return new PairingCode(DEFAULT_ORIGIN, value);

        String address = text.substring(0, separator);
        String url = address.contains("://") ? address : "https://" + address;
        return new PairingCode(requireTrustedOrigin(url), value);
    }

    static String requireTrustedOrigin(String url) {
        URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException malformed) {
            throw new IllegalArgumentException("Koddaki HAN Hukuk adresi geçersiz.");
        }
        String host = uri.getHost();
        if (host == null || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getPort() != -1
                || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath()))) {
            throw new IllegalArgumentException("Koddaki HAN Hukuk adresi geçersiz.");
        }
        host = host.toLowerCase(Locale.ROOT);
        if (!host.equals("hanhukuktakip.com") && !host.endsWith(".hanhukuktakip.com")) {
            throw new IllegalArgumentException("Koddaki HAN Hukuk adresi geçersiz.");
        }
        return "https://" + host;
    }
}
