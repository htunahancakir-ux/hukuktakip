package com.hanhukuk.gsm;

public final class PairingCodeTest {
    private static final String PRODUCTION = "https://www.hanhukuktakip.com";
    private static final String CODE = "11111111-2222-3333-4444-555555555555.AbCdEf1234_xyZ-0";

    public static void main(String[] args) {
        accepts("the code without a web address", CODE, PRODUCTION);
        accepts("the code from the web Copy button", "www.hanhukuktakip.com/" + CODE, PRODUCTION);
        accepts("a pasted HTTPS link", PRODUCTION + "/" + CODE, PRODUCTION);
        accepts("a clipboard line break and invisible marks", "\u200e" + PRODUCTION + "/\n" + CODE + "\u00a0", PRODUCTION);
        accepts("another HAN Hukuk office", "OFFICE.hanhukuktakip.com/" + CODE, "https://office.hanhukuktakip.com");

        rejects("an incomplete code", CODE.substring(CODE.indexOf('.') + 1));
        rejects("an invalid secret length", PRODUCTION + "/" + CODE + "x");
        rejects("an HTTP origin", "http://www.hanhukuktakip.com/" + CODE);
        rejects("an unrelated host", "https://hanhukuktakip.com.example.org/" + CODE);
        rejects("a URL with credentials", "https://example.org@www.hanhukuktakip.com/" + CODE);
        rejects("a URL with an unrelated path", PRODUCTION + "/wrong-path/" + CODE);
        System.out.println("Android pairing code checks passed");
    }

    private static void accepts(String name, String input, String expectedOrigin) {
        PairingCode result = PairingCode.parse(input);
        if (!expectedOrigin.equals(result.origin) || !CODE.equals(result.value)) {
            throw new AssertionError("Incorrect parsing of " + name);
        }
    }

    private static void rejects(String name, String input) {
        try {
            PairingCode.parse(input);
        } catch (IllegalArgumentException expected) {
            return;
        }
        throw new AssertionError("Accepted " + name);
    }
}
