package com.displayos.kiosk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import org.json.JSONObject;

public final class PreparationReceiver extends BroadcastReceiver {
    @Override public void onReceive(final Context context, Intent intent) {
        if (!BuildConfig.DEBUG || (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0 || !"com.displayos.kiosk.PREPARE".equals(intent.getAction())) return;
        final PendingResult result = goAsync();
        new Thread(new Runnable() { @Override public void run() {
            File file = new File(context.getFilesDir(), "preparation.json");
            try {
                if (!file.isFile() || file.length() > 8192) throw new SecurityException("Invalid preparation artifact.");
                byte[] data = new byte[(int) file.length()];
                try (FileInputStream input = new FileInputStream(file)) { int offset = 0; int count; while (offset < data.length && (count = input.read(data, offset, data.length - offset)) > 0) offset += count; if (offset != data.length) throw new IllegalStateException("Incomplete preparation."); }
                JSONObject preparation = new JSONObject(new String(data, StandardCharsets.UTF_8));
                Map<String, Object> fields = new HashMap<String, Object>();
                Iterator<String> names = preparation.keys();
                while (names.hasNext()) { String name = names.next(); fields.put(name, preparation.get(name)); }
                EnrollmentPolicy.fields(fields);
                NativeClient client = new NativeClient(context, new Protocol(BuildConfig.ORIGIN));
                client.prepare((String) fields.get("ticket"), (String) fields.get("ownerPin"), (String) fields.get("deviceId"));
                context.startActivity(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
                result.setResultCode(0);
            } catch (Exception error) { result.setResultCode(1); }
            finally { if (file.exists()) file.delete(); result.finish(); }
        } }, "displayos-preparation").start();
    }
}
