package com.hanhukuk.gsm;

import java.awt.image.BufferedImage;
import java.io.File;
import javax.imageio.ImageIO;

public final class PairingQrTest {
    public static void main(String[] args) throws Exception {
        BufferedImage valid = ImageIO.read(new File(args[0], "valid.gif"));
        byte[] frame = luminance(valid);
        PairingCode code = QrPairingCode.read(frame, valid.getWidth(), valid.getHeight());
        check(code.origin.equals("https://www.hanhukuktakip.com"), "Wrong office origin");
        check(code.value.equals("phone-1.AbCdEf1234_xyZ-0"), "Wrong pairing code");
        byte[] rotated = new byte[frame.length];
        for (int i = 0; i < frame.length; i++) rotated[i] = frame[frame.length - 1 - i];
        check(QrPairingCode.read(rotated, valid.getWidth(), valid.getHeight()).value.equals(code.value), "Rotated QR rejected");
        for (String name : new String[] { "untrusted", "incomplete" }) {
            BufferedImage image = ImageIO.read(new File(args[0], name + ".gif"));
            try {
                QrPairingCode.read(luminance(image), image.getWidth(), image.getHeight());
                throw new AssertionError("Accepted " + name + " QR");
            } catch (IllegalArgumentException expected) {}
        }
        System.out.println("Web-generated pairing QR decoded locally; rotated, untrusted and incomplete QR checks passed");
    }

    private static byte[] luminance(BufferedImage image) {
        byte[] frame = new byte[image.getWidth() * image.getHeight()];
        for (int y = 0; y < image.getHeight(); y++)
            for (int x = 0; x < image.getWidth(); x++) frame[y * image.getWidth() + x] = (byte) (image.getRGB(x, y) & 255);
        return frame;
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
