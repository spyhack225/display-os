package com.displayos.kiosk;

import android.app.admin.DeviceAdminReceiver;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;

public final class KioskAdmin extends DeviceAdminReceiver {
    public static void configureIfOwner(Context context) {
        DevicePolicyManager manager = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (manager == null || !manager.isDeviceOwnerApp(context.getPackageName())) return;
        ComponentName admin = new ComponentName(context, KioskAdmin.class);
        manager.setLockTaskPackages(admin, new String[] { context.getPackageName() });
        if (Build.VERSION.SDK_INT >= 28) manager.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
        IntentFilter filter = new IntentFilter(Intent.ACTION_MAIN); filter.addCategory(Intent.CATEGORY_HOME); filter.addCategory(Intent.CATEGORY_DEFAULT);
        manager.addPersistentPreferredActivity(admin, filter, new ComponentName(context, MainActivity.class));
    }
}
