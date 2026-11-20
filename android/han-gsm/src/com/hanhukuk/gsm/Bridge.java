package com.hanhukuk.gsm;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.PowerManager;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

final class Bridge {
    static final String ACR_PACKAGE = "com.nll.cb";

    static SharedPreferences settings(Context context) {
        return context.getSharedPreferences("connection", Context.MODE_PRIVATE);
    }

    static String origin(String input) {
        URI uri = URI.create(input.trim());
        String host = uri.getHost();
        if (host == null || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getPort() != -1
                || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !("".equals(uri.getRawPath()) || "/".equals(uri.getRawPath()))) {
            throw new IllegalArgumentException("HAN Hukuk sitesinin https adresini girin.");
        }
        host = host.toLowerCase(Locale.ROOT);
        if (!host.equals("hanhukuktakip.com") && !host.endsWith(".hanhukuktakip.com")) {
            throw new IllegalArgumentException("HAN Hukuk sitesinin https adresini girin.");
        }
        return "https://" + host;
    }

    static JSONObject request(String origin, String token, JSONObject input) throws Exception {
        URL url = new URL(origin(origin) + "/api/voip/acr-agent");
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(4000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
            byte[] body = input.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) throw new Unlinked();
            if (status != 200) throw new IOException("HTTP " + status);
            try (InputStream response = connection.getInputStream();
                    ByteArrayOutputStream result = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[1024];
                for (int size; (size = response.read(buffer)) != -1;) {
                    if (result.size() + size > 8192) throw new IOException("Yanıt boyutu");
                    result.write(buffer, 0, size);
                }
                return new JSONObject(result.toString("UTF-8"));
            }
        } finally {
            connection.disconnect();
        }
    }

    static String[] missingPermissions(Context context) {
        ArrayList<String> missing = new ArrayList<>();
        for (String permission : new String[] { Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE }) {
            if (context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
        }
        if (Build.VERSION.SDK_INT >= 31
                && context.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.READ_PHONE_NUMBERS);
        }
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        return missing.toArray(new String[0]);
    }

    static boolean canRunWhileIdle(Context context) {
        return context.getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(context.getPackageName());
    }

    static PhoneAccountHandle sim(TelecomManager telecom) {
        PhoneAccountHandle handle = telecom.getDefaultOutgoingPhoneAccount(PhoneAccount.SCHEME_TEL);
        if (handle == null) return null;
        PhoneAccount account = telecom.getPhoneAccount(handle);
        return account != null && account.hasCapabilities(PhoneAccount.CAPABILITY_SIM_SUBSCRIPTION) ? handle : null;
    }

    static final class Unlinked extends IOException {}

    private Bridge() {}
}
