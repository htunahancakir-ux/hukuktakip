package com.hanhukuk.gsm;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

// Frames are decoded locally and discarded. The camera is released whenever this screen is left.
public final class QrScanActivity extends Activity implements SurfaceHolder.Callback {
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final AtomicBoolean decoding = new AtomicBoolean();
    private Camera camera;
    private SurfaceView preview;
    private TextView message;
    private volatile boolean active;
    private boolean surfaceReady;
    private long lastFrame;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        message = new TextView(this);
        message.setText("Sitedeki Android eşleştirme QR kodunu kameraya gösterin. Görüntü telefonda okunur ve saklanmaz.");
        message.setTextSize(18);
        message.setPadding(24, 48, 24, 24);
        message.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        layout.addView(message);
        preview = new SurfaceView(this);
        preview.getHolder().addCallback(this);
        layout.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));
        Button cancel = new Button(this);
        cancel.setText("Vazgeç");
        cancel.setOnClickListener(view -> finish());
        layout.addView(cancel);
        setContentView(layout);
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[] { Manifest.permission.CAMERA }, 4);
    }

    @Override protected void onResume() {
        super.onResume();
        active = true;
        openCamera();
    }

    @Override protected void onPause() {
        active = false;
        releaseCamera();
        super.onPause();
    }

    @Override protected void onDestroy() {
        decoder.shutdownNow();
        super.onDestroy();
    }

    @Override public void surfaceCreated(SurfaceHolder holder) { surfaceReady = true; openCamera(); }
    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}
    @Override public void surfaceDestroyed(SurfaceHolder holder) { surfaceReady = false; releaseCamera(); }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request != 4) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openCamera();
        else message.setText("QR okumak için kamera izni gerekli. Vazgeç ile dönüp eşleştirme kodunu elle de girebilirsiniz.");
    }

    private void openCamera() {
        if (!active || !surfaceReady || camera != null
                || checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        try {
            int cameraId = -1;
            Camera.CameraInfo info = new Camera.CameraInfo();
            for (int i = 0; i < Camera.getNumberOfCameras(); i++) {
                Camera.getCameraInfo(i, info);
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) { cameraId = i; break; }
            }
            if (cameraId < 0) throw new IllegalStateException("No back camera");
            camera = Camera.open(cameraId);
            Camera.getCameraInfo(cameraId, info);
            int rotation = getWindowManager().getDefaultDisplay().getRotation() * 90;
            camera.setDisplayOrientation((info.orientation - rotation + 360) % 360);
            Camera.Parameters parameters = camera.getParameters();
            Camera.Size size = null;
            for (Camera.Size option : parameters.getSupportedPreviewSizes())
                if (option.width >= 640 && option.width <= 1280 && (size == null || option.width * option.height < size.width * size.height)) size = option;
            if (size == null) size = parameters.getSupportedPreviewSizes().get(0);
            parameters.setPreviewSize(size.width, size.height);
            parameters.setPreviewFormat(ImageFormat.NV21);
            if (parameters.getSupportedFocusModes() != null
                    && parameters.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE))
                parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            camera.setParameters(parameters);
            final int width = size.width, height = size.height;
            camera.setPreviewDisplay(preview.getHolder());
            camera.setPreviewCallback((bytes, source) -> {
                long now = android.os.SystemClock.elapsedRealtime();
                if (!active || now - lastFrame < 300 || !decoding.compareAndSet(false, true)) return;
                lastFrame = now;
                byte[] frame = bytes.clone();
                decoder.execute(() -> decode(frame, width, height));
            });
            camera.startPreview();
        } catch (Exception unavailable) {
            releaseCamera();
            message.setText("Kamera açılamadı. Kamera iznini kontrol edin veya eşleştirme kodunu elle girin.");
        }
    }

    private void decode(byte[] frame, int width, int height) {
        try {
            PairingCode parsed = QrPairingCode.read(frame, width, height);
            runOnUiThread(() -> {
                if (!active) return;
                active = false;
                setResult(RESULT_OK, new Intent().putExtra("pairingCode", parsed.origin + "/" + parsed.value));
                finish();
            });
        } catch (com.google.zxing.ReaderException noCode) {
            // Keep scanning until a QR is in focus.
        } catch (IllegalArgumentException unrelatedCode) {
            runOnUiThread(() -> { if (active) message.setText("Bu kod bir HAN Hukuk Android eşleştirme kodu değil."); });
        } finally { decoding.set(false); }
    }

    private void releaseCamera() {
        if (camera == null) return;
        try { camera.setPreviewCallback(null); camera.stopPreview(); } catch (RuntimeException ignored) {}
        camera.release();
        camera = null;
    }
}
