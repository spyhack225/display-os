package com.displayos.kiosk;

import java.util.Map;

public final class EnrollmentPolicy {
    private EnrollmentPolicy() { }
    public static void fields(Map<String, Object> input) {
        boolean pin = input.containsKey("ownerPin");
        if (input.size() != (pin ? 3 : 2) || !(input.get("ticket") instanceof String) || !(input.get("deviceId") instanceof String) || (pin && !(input.get("ownerPin") instanceof String))) throw new SecurityException("Unexpected preparation fields or types.");
        if (pin) Protocol.requirePin((String) input.get("ownerPin"));
    }
    public static void prepare(boolean prepared, boolean hasPin, String pendingId, boolean deferred, String deviceId, String pin) {
        if (prepared) throw new SecurityException("This installation is already enrolled.");
        if (deviceId != null && !deviceId.matches("[A-Za-z0-9_-]{16,128}")) throw new SecurityException("Invalid factory unit identifier.");
        if (pendingId != null && deviceId != null && !pendingId.equals(deviceId)) throw new SecurityException("Another factory identity is pending. Recover it instead.");
        if (pin == null) {
            if (hasPin || deviceId == null || (pendingId != null && !deferred)) throw new SecurityException("Deferred PIN is allowed only for a fresh unclaimed enrollment.");
        } else Protocol.requirePin(pin);
    }
    public static void unclaimed(String state, boolean snapshot) {
        if (!"unclaimed".equals(state) || snapshot) throw new SecurityException("Deferred PIN requires an unclaimed unit without family content.");
    }
    public static boolean clearPinAfterRecovery(boolean resetPending, String state) {
        return resetPending && "unclaimed".equals(state);
    }
}
