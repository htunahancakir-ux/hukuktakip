package com.hanhukuk.gsm;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.provider.Settings;
import android.telecom.TelecomManager;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private SharedPreferences settings;
    private EditText code;
    private Button paste;
    private Button scan;
    private Button pair;
    private Button start;
    private Button stop;
    private TextView status;
    private TextView backgroundStatus;
    private boolean pairing;
    private boolean activateAfterPair;
    private final SharedPreferences.OnSharedPreferenceChangeListener listener = (preferences, key) -> render();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        settings = Bridge.settings(this);
        ScrollView scroll = new ScrollView(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (32 * getResources().getDisplayMetrics().density);
        content.setPadding(padding, padding, padding, padding);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            content.setPadding(padding, padding + insets.getSystemWindowInsetTop(), padding,
                    padding + insets.getSystemWindowInsetBottom());
            return insets;
        });
        scroll.addView(content);
        setContentView(scroll);

        TextView title = new TextView(this);
        title.setText("HAN GSM Bağlantısı");
        title.setTextSize(26);
        title.setTypeface(null, Typeface.BOLD);
        content.addView(title);
        TextView description = new TextView(this);
        description.setText("Bilgisayarda GSM ile ara seçildiğinde bu telefon SIM hattından arar. "
                + "ACR Phone’u varsayılan telefon uygulaması yapın ve Android ayarlarında aramalar için bir SIM seçin.");
        description.setTextSize(16);
        content.addView(description);
        status = new TextView(this);
        status.setTextSize(16);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        content.addView(status);

        code = new EditText(this);
        code.setHint("Android eşleştirme kodu");
        code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        code.setSingleLine();
        code.setSaveEnabled(false);
        code.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        content.addView(code);

        scan = button(content, "QR kod ile eşleştir", () -> startActivityForResult(new Intent(this, QrScanActivity.class), 3));
        paste = button(content, "Panodan yapıştır", this::pasteCode);
        pair = button(content, "Eşleştir", this::pair);
        start = button(content, "Otomatik aramayı aç", this::activate);
        stop = button(content, "Otomatik aramayı durdur", () -> {
            settings.edit().putBoolean("enabled", false).putString("status", "Otomatik arama durduruldu.").apply();
            stopService(new Intent(this, DialService.class));
        });
        TextView backgroundTitle = new TextView(this);
        backgroundTitle.setText("Arka planda çalışma · v1.2");
        backgroundTitle.setTextSize(20);
        backgroundTitle.setTypeface(null, Typeface.BOLD);
        content.addView(backgroundTitle);
        TextView backgroundHelp = new TextView(this);
        backgroundHelp.setText("Bu ekranı kapatabilirsiniz. Bağlantı, HAN GSM Bağlantısı bildirimiyle arka planda çalışır. "
                + "Telefon açılıp ilk kilidi açıldığında, otomatik arama önceden açıksa yeniden bağlanır. "
                + "Android’de Zorla durdur kullanırsanız uygulamayı bir kez tekrar açın.");
        backgroundHelp.setTextSize(16);
        content.addView(backgroundHelp);
        Switch boot = new Switch(this);
        boot.setText("Telefon açılınca otomatik bağlan");
        boot.setChecked(settings.getBoolean("startOnBoot", true));
        boot.setOnCheckedChangeListener((button, checked) -> settings.edit().putBoolean("startOnBoot", checked).apply());
        content.addView(boot);
        backgroundStatus = new TextView(this);
        backgroundStatus.setTextSize(16);
        content.addView(backgroundStatus);
        button(content, "Pil kısıtlamasını kaldır", this::batterySettings);
        TextView deviceHelp = new TextView(this);
        String manufacturer = Build.MANUFACTURER.toLowerCase(java.util.Locale.ROOT);
        String deviceInstructions = manufacturer.contains("xiaomi") || manufacturer.contains("poco") || manufacturer.contains("redmi")
                ? "Xiaomi / Redmi / POCO: Ayarlar → Uygulamalar → Arka planda otomatik başlat bölümünde HAN GSM Bağlantısı’nı açın. "
                  + "Bazı sürümlerde bu seçenek İzinler altındadır. Uygulamanın pil ayarını Kısıtlama yok yapın."
                : manufacturer.contains("samsung")
                ? "Samsung: Ayarlar → Pil → Arka plan kullanım sınırları → Uykuya alınmayan uygulamalar listesine HAN GSM Bağlantısı’nı ekleyin."
                : "Telefonun uygulama ayarlarında arka planda çalışmaya ve otomatik başlatmaya izin verin. Pil kısıtlamasını kaldırın.";
        deviceHelp.setText(Build.MANUFACTURER + " " + Build.MODEL + " · Android " + Build.VERSION.RELEASE + "\n" + deviceInstructions);
        deviceHelp.setTextSize(16);
        content.addView(deviceHelp);
        if (manufacturer.contains("samsung")) {
            button(content, "Samsung: Uykuya alınmayan uygulamalar", () -> {
                try {
                    startActivity(new Intent("com.samsung.android.sm.ACTION_OPEN_CHECKABLE_LISTACTIVITY")
                            .setPackage("com.samsung.android.lool").putExtra("activity_type", 2));
                } catch (RuntimeException unavailable) {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", getPackageName(), null)));
                }
            });
        }
        button(content, "Android uygulama ayarları", () -> startActivity(new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null))));
        render();
    }

    private Button button(LinearLayout parent, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setOnClickListener(view -> action.run());
        parent.addView(button);
        return button;
    }

    @Override protected void onStart() {
        super.onStart();
        settings.registerOnSharedPreferenceChangeListener(listener);
        if (settings.getBoolean("enabled", false) && settings.contains("token")) startConnection();
        render();
    }

    @Override protected void onStop() {
        settings.unregisterOnSharedPreferenceChangeListener(listener);
        super.onStop();
    }

    @Override protected void onResume() {
        super.onResume();
        render();
    }

    private void render() {
        boolean linked = settings.contains("token");
        boolean enabled = settings.getBoolean("enabled", false);
        status.setText(settings.getString("status", "HAN Hukuk’ta Kodu kopyala’ya, burada Panodan yapıştır’a dokunun."));
        pair.setEnabled(!pairing && !enabled);
        paste.setEnabled(!pairing && !enabled);
        scan.setEnabled(!pairing && !enabled);
        code.setEnabled(!pairing && !enabled);
        start.setEnabled(linked && !pairing);
        start.setText(enabled ? "Bağlantıyı yeniden başlat" : "Otomatik aramayı aç");
        stop.setEnabled(enabled);
        if (backgroundStatus != null) {
            boolean notifications = getSystemService(NotificationManager.class).areNotificationsEnabled();
            backgroundStatus.setText("Pil kısıtlaması: " + (Bridge.canRunWhileIdle(this) ? "kaldırılmış" : "kaldırılmalı")
                    + "\nBağlantı bildirimi: " + (notifications ? "açık" : "Android ayarlarından açılmalı")
                    + "\nTelefon açılışında yeniden başlatma: " + (settings.getBoolean("startOnBoot", true) ? "açık" : "kapalı"));
        }
    }

    private void pasteCode() {
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        ClipData content = clipboard == null ? null : clipboard.getPrimaryClip();
        CharSequence text = content == null || content.getItemCount() == 0 ? null : content.getItemAt(0).getText();
        if (text == null || text.length() == 0) {
            code.setError("Panoda kod yok. Önce HAN Hukuk’tan kodu kopyalayın.");
            return;
        }
        code.setText(text);
        code.setSelection(0);
        code.setError(null);
    }

    private void pair() {
        PairingCode input;
        try {
            input = PairingCode.parse(code.getText().toString());
        } catch (IllegalArgumentException invalid) {
            activateAfterPair = false;
            code.setError(invalid.getMessage());
            return;
        }
        code.setError(null);
        pairing = true;
        render();
        status.setText("Telefon eşleştiriliyor.");
        new Thread(() -> {
            String message;
            boolean pairedOk = false;
            try {
                JSONObject result = Bridge.request(input.origin, "", new JSONObject().put("pairingCode", input.value));
                String token = result.getString("token");
                if (!token.matches("[A-Za-z0-9_-]{43}")) throw new java.io.IOException("Yanıt");
                settings.edit().putString("origin", input.origin).putString("token", token)
                        .putString("deviceId", result.getString("deviceId"))
                        .putString("accountId", result.getString("accountId"))
                        .remove("lastDial").apply();
                message = "Telefon eşleştirildi. Otomatik aramayı açabilirsiniz.";
                pairedOk = true;
            } catch (Bridge.Unlinked expired) {
                message = "Kod geçersiz, kullanılmış veya süresi dolmuş. Web’den yeni kod oluşturun.";
            } catch (Exception failed) {
                message = "HAN Hukuk’a bağlanılamadı. İnternet bağlantısını kontrol edin.";
            }
            settings.edit().putString("status", message).apply();
            final boolean success = pairedOk;
            runOnUiThread(() -> {
                pairing = false;
                if (settings.contains("token")) code.setText("");
                render();
                if (activateAfterPair && success) activate();
                activateAfterPair = false;
            });
        }, "han-gsm-pair").start();
    }

    private void activate() {
        String[] missing = Bridge.missingPermissions(this);
        if (missing.length > 0) {
            requestPermissions(missing, 1);
            return;
        }
        TelecomManager telecom = getSystemService(TelecomManager.class);
        if (telecom == null || !Bridge.ACR_PACKAGE.equals(telecom.getDefaultDialerPackage())) {
            status.setText("Android ayarlarında ACR Phone’u varsayılan telefon uygulaması yapın.");
            return;
        }
        if (Bridge.sim(telecom) == null) {
            status.setText("Android SIM ayarlarında aramalar için bir SIM seçin.");
            return;
        }
        if (!Bridge.canRunWhileIdle(this)) {
            status.setText("Ekran kapalıyken arama alabilmek için pil iznini verin.");
            batterySettings();
            return;
        }
        settings.edit().putBoolean("enabled", true).apply();
        startConnection();
    }

    private void startConnection() {
        try {
            startForegroundService(new Intent(this, DialService.class));
        } catch (RuntimeException unavailable) {
            settings.edit().putString("status", "Android bağlantıyı başlatamadı. Bağlantıyı yeniden başlat’a dokunun.").apply();
        }
    }

    private void batterySettings() {
        try {
            if (Bridge.canRunWhileIdle(this)) {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", getPackageName(), null)));
            } else {
                startActivityForResult(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.fromParts("package", getPackageName(), null)), 2);
            }
        } catch (RuntimeException unavailable) {
            status.setText("Telefonun uygulama ayarlarından Pil → Kısıtlama yok seçin.");
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request != 1) return;
        if (Bridge.missingPermissions(this).length == 0) activate();
        else status.setText("Otomatik arama için istenen izinleri Android uygulama ayarlarından açın.");
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 2 && Bridge.canRunWhileIdle(this)) activate();
        if (request == 3 && result == RESULT_OK && data != null) {
            code.setText(data.getStringExtra("pairingCode"));
            activateAfterPair = true;
            pair();
        }
    }
}
