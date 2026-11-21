package com.hanhukuk.gsm.tests;

import android.Manifest;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.SystemClock;

// Separate, same-signature test APK. Never included in the downloadable application.
public final class LifecycleInstrumentation extends Instrumentation {
    private String mode;
    private Context target;
    private SharedPreferences preferences;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        mode = arguments == null ? "checks" : arguments.getString("mode", "checks");
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            target = getTargetContext();
            preferences = target.getSharedPreferences("connection", Context.MODE_PRIVATE);
            // This suite must never be run on a real, paired phone or initiate a call.
            check(target.checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED,
                    "Use an isolated emulator without phone permission");
            check(!preferences.contains("token") || preferences.getString("token", "").equals("test-only-no-network-token"),
                    "Refusing to replace a real pairing");
            if (mode.endsWith("-prepare")) {
                // BOOT_COMPLETED is not delivered to a newly installed app before its first normal launch.
                seed(false, false, true);
                Activity firstLaunch = startActivitySync(new Intent().setComponent(new ComponentName(
                        target.getPackageName(), "com.hanhukuk.gsm.MainActivity")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                runOnMainSync(firstLaunch::finish);
                SystemClock.sleep(400);
                seed(true, true, mode.startsWith("boot"));
            } else if (mode.endsWith("-verify")) {
                check(preferences.getString("lastResumeAction", "").equals(mode.startsWith("boot")
                        ? Intent.ACTION_BOOT_COMPLETED : Intent.ACTION_MY_PACKAGE_REPLACED),
                        "System resume broadcast was not received; enabled=" + preferences.getBoolean("enabled", false)
                        + ", paired=" + preferences.contains("token") + ", boot=" + preferences.getBoolean("startOnBoot", false)
                        + ", status=" + preferences.getString("status", "") + ", storage=" + target.getDataDir());
                waitForPause();
                check(preferences.getBoolean("enabled", false), "Restart disabled the saved user choice");
                check(preferences.getString("deviceId", "").equals("test-device"), "Update lost the pairing");
                clear();
            } else {
                seed(false, true, true);
                receive(Intent.ACTION_BOOT_COMPLETED);
                unchanged("Explicit stop must survive reboot");
                seed(true, false, true);
                receive(Intent.ACTION_BOOT_COMPLETED);
                unchanged("An unpaired phone must never resume");
                seed(true, true, false);
                receive(Intent.ACTION_BOOT_COMPLETED);
                unchanged("Boot preference must be respected");
                receive(Intent.ACTION_MY_PACKAGE_REPLACED);
                waitForPause();
                check(preferences.getBoolean("enabled", false), "Temporary permission failure erased the active choice");
                seed(true, true, true);
                receive(Intent.ACTION_BOOT_COMPLETED);
                waitForPause();
                check(preferences.getBoolean("enabled", false), "Boot attempt erased the active choice");
                target.startForegroundService(new Intent().setComponent(new ComponentName(target.getPackageName(),
                        "com.hanhukuk.gsm.DialService")).setAction("com.hanhukuk.gsm.STOP"));
                long deadline = SystemClock.elapsedRealtime() + 5000;
                while (preferences.getBoolean("enabled", true) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
                check(!preferences.getBoolean("enabled", true), "Explicit Stop must disable automatic resume");
                clear();
            }
            result.putString("stream", "HAN GSM lifecycle " + mode + " passed\n");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable failure) {
            result.putString("stream", "HAN GSM lifecycle " + mode + " failed: " + failure + "\n");
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private void seed(boolean enabled, boolean paired, boolean boot) {
        clear();
        SharedPreferences.Editor edit = preferences.edit().putBoolean("enabled", enabled)
                .putBoolean("startOnBoot", boot).putString("status", "untouched")
                .putString("lastResumeAction", "").putLong("lastResumeAt", 0);
        if (paired) edit.putString("token", "test-only-no-network-token").putString("deviceId", "test-device");
        check(edit.commit(), "Could not seed isolated test state");
    }

    private void clear() {
        target.stopService(new Intent().setComponent(new ComponentName(target.getPackageName(), "com.hanhukuk.gsm.DialService")));
        SystemClock.sleep(200);
        check(preferences.edit().clear().commit(), "Could not clear isolated test state");
    }

    private void receive(String action) throws Exception {
        Class<?> receiver = Class.forName("com.hanhukuk.gsm.ResumeConnection", true, target.getClassLoader());
        ((BroadcastReceiver) receiver.newInstance()).onReceive(target, new Intent(action));
    }

    private void unchanged(String message) {
        SystemClock.sleep(400);
        check("untouched".equals(preferences.getString("status", "")), message);
    }

    private void waitForPause() {
        long deadline = SystemClock.elapsedRealtime() + 8000;
        while (!preferences.getString("status", "").contains("izin") && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(100);
        check(preferences.getString("status", "").contains("izin"),
                "Expected a missing-permission pause, got: " + preferences.getString("status", ""));
    }

    private void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
