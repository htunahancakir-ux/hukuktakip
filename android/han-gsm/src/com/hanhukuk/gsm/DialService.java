package com.hanhukuk.gsm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

public final class DialService extends Service {
    private static final String CHANNEL = "han-gsm";
    private static final String STOP = "com.hanhukuk.gsm.STOP";
    private static final String READY = "Bilgisayardan gelen GSM aramaları bekleniyor.";
    private static final int NOTIFICATION = 1;
    private SharedPreferences settings;
    private NotificationManager notifications;
    private ScheduledExecutorService worker;
    private PowerManager.WakeLock connectionLock;
    private volatile boolean running;

    @Override public void onCreate() {
        super.onCreate();
        settings = Bridge.settings(this);
        notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL, "Otomatik GSM araması",
                NotificationManager.IMPORTANCE_LOW));
    }

    @Override public int onStartCommand(Intent intent, int flags, int id) {
        try {
            Notification connection = notification(running
                    ? settings.getString("status", READY) : "HAN Hukuk’a bağlanılıyor.");
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION, connection, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION, connection);
            }
            // Even a STOP racing with startForegroundService must satisfy Android's foreground deadline.
            if (intent != null && STOP.equals(intent.getAction())) {
                stop("Otomatik arama durduruldu.");
                return START_NOT_STICKY;
            }
            if (!settings.getBoolean("enabled", false) || !settings.contains("token")) {
                stopSelf();
                return START_NOT_STICKY;
            }
            if (running) return START_STICKY;
            if (!Bridge.canRunWhileIdle(this)) {
                pause("Ekran kapalıyken arama alabilmek için pil iznini verin.");
                return START_NOT_STICKY;
            }
            connectionLock = getSystemService(PowerManager.class)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "com.hanhukuk.gsm:connection");
            connectionLock.acquire();
        } catch (RuntimeException unavailable) {
            pause("Otomatik arama başlatılamadı. Uygulamayı tekrar açın.");
            return START_NOT_STICKY;
        }
        running = true;
        worker = Executors.newSingleThreadScheduledExecutor();
        worker.scheduleWithFixedDelay(this::poll, 0, 2, TimeUnit.SECONDS);
        return START_STICKY;
    }

    private boolean enabled() {
        return running && settings.getBoolean("enabled", false);
    }

    private void poll() {
        if (!enabled()) return;
        if (Bridge.missingPermissions(this).length != 0 || !Bridge.canRunWhileIdle(this)) {
            pause("Bağlantı bekletiliyor. Telefon, bildirim ve pil izinlerini kontrol edin.");
            return;
        }
        TelecomManager telecom = getSystemService(TelecomManager.class);
        try {
            if (telecom == null || !Bridge.ACR_PACKAGE.equals(telecom.getDefaultDialerPackage())) {
                update("ACR Phone’u varsayılan telefon uygulaması yapın.");
                return;
            }
            PhoneAccountHandle sim = Bridge.sim(telecom);
            if (sim == null) {
                update("Android ayarlarında aramalar için bir SIM seçin.");
                return;
            }
            if (telecom.isInCall()) {
                update("Süren aramanın tamamlanması bekleniyor.");
                return;
            }
            long started = SystemClock.elapsedRealtime();
            JSONObject response = Bridge.request(settings.getString("origin", ""), settings.getString("token", ""),
                    new JSONObject().put("deviceId", settings.getString("deviceId", ""))
                            .put("accountId", settings.getString("accountId", "")));
            if (!enabled()) return;
            JSONObject dial = response.optJSONObject("dial");
            if (dial == null) {
                update(READY);
                return;
            }
            String id = dial.getString("id");
            String phone = dial.getString("phone");
            long remaining = dial.getLong("launchWithinMs");
            if (!phone.matches("90[1-9][0-9]{9}") || remaining <= 0 || remaining > 12000
                    || SystemClock.elapsedRealtime() - started >= remaining
                    || id.equals(settings.getString("lastDial", ""))
                    || !Bridge.ACR_PACKAGE.equals(telecom.getDefaultDialerPackage())
                    || !sim.equals(Bridge.sim(telecom)) || telecom.isInCall()) return;
            if (!settings.edit().putString("lastDial", id).commit() || !enabled()
                    || SystemClock.elapsedRealtime() - started >= remaining) return;
            Bundle options = new Bundle();
            options.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, sim);
            telecom.placeCall(Uri.fromParts(PhoneAccount.SCHEME_TEL, "+" + phone, null), options);
            update("GSM araması Android’e iletildi.");
        } catch (Bridge.Unlinked revoked) {
            if (!enabled()) return;
            settings.edit().remove("token").remove("deviceId").remove("accountId").apply();
            stop("Eşleşme sona erdi. HAN Hukuk’tan yeni kod oluşturun.");
        } catch (SecurityException denied) {
            pause("Android arama izni vermedi. Telefon ayarlarını kontrol edin.");
        } catch (Exception unavailable) {
            update("HAN Hukuk bağlantısı bekleniyor.");
        }
    }

    private Notification notification(String message) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), flags);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, DialService.class).setAction(STOP), flags);
        return new Notification.Builder(this, CHANNEL)
                .setContentTitle("HAN GSM Bağlantısı")
                .setContentText(message)
                .setSmallIcon(android.R.drawable.ic_menu_call)
                .setOngoing(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Durdur", stop).build())
                .build();
    }

    private void update(String message) {
        if (!enabled() || message.equals(settings.getString("status", ""))) return;
        settings.edit().putString("status", message).apply();
        notifications.notify(NOTIFICATION, notification(message));
    }

    private void stop(String message) {
        running = false;
        settings.edit().putBoolean("enabled", false).putString("status", message).apply();
        stopSelf();
    }

    private void pause(String message) {
        running = false;
        settings.edit().putString("status", message).apply();
        stopSelf();
    }

    @Override public void onDestroy() {
        running = false;
        if (worker != null) worker.shutdownNow();
        if (connectionLock != null && connectionLock.isHeld()) connectionLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }
}
