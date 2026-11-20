package com.hanhukuk.gsm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

public final class ResumeConnection extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        SharedPreferences settings = Bridge.settings(context);
        if (!settings.getBoolean("enabled", false) || !settings.contains("token")) return;
        try {
            context.startForegroundService(new Intent(context, DialService.class));
        } catch (RuntimeException unavailable) {
            settings.edit().putBoolean("enabled", false)
                    .putString("status", "Bağlantıyı yeniden başlatmak için Otomatik aramayı aç’a dokunun.").apply();
        }
    }
}
