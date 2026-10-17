package com.displayos.kiosk;

import org.json.JSONObject;

public final class SnapshotState {
    private SnapshotState() { }
    public static JSONObject snapshot(JSONObject state) {
        if (state == null) return null;
        Object value = state.opt("snapshot");
        if (value == null || value == JSONObject.NULL) return null;
        if (!(value instanceof JSONObject)) throw new SecurityException("Snapshot must be an object or null.");
        return (JSONObject) value;
    }
    public static boolean hasSnapshot(JSONObject state) { return snapshot(state) != null; }
    public static boolean contentRemoved(JSONObject previous, JSONObject next) { return hasSnapshot(previous) && !hasSnapshot(next); }
    public static long expiry(JSONObject state, long deadline, long elapsed, long fetchedAt, long now) {
        JSONObject content = snapshot(state);
        if (content == null) return 0;
        long expiresAt = state.optLong("expiresAt", content.optLong("expiresAt"));
        if (deadline <= elapsed || now < fetchedAt - 300000L || expiresAt <= now) return 1;
        return expiresAt;
    }
}
