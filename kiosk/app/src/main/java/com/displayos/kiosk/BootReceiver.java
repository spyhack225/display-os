package com.displayos.kiosk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        try { context.startActivity(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (RuntimeException error) { }
    }
}
