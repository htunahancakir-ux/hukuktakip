package com.hanhukuk.gsm;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.ReaderException;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

final class QrPairingCode {
    static PairingCode read(byte[] frame, int width, int height) throws ReaderException {
        String text = new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(
                new PlanarYUVLuminanceSource(frame, width, height, 0, 0, width, height, false)))).getText();
        return PairingCode.parse(text);
    }
}
