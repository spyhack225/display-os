package com.displayos.kiosk;

import org.json.JSONObject;

public final class DeviceCommandPolicy {
    private DeviceCommandPolicy() { }
    static final String VOICE = "/device/v1/voice";
    static final String LISTS = "/device/v1/lists";
    private static final String ID = "[A-Za-z0-9_-]{1,64}";
    private static final String PART = "[A-Za-z0-9+/=]{1,5600}";
    public static void check(String path, JSONObject body) {
        if (VOICE.equals(path)) { voice(body); return; }
        if (LISTS.equals(path)) { lists(body); return; }
        if (body.length() != 0) throw new SecurityException("Unexpected native command data.");
    }
    private static void voice(JSONObject body) {
        String action = body.optString("action");
        if ("begin".equals(action)) {
            if (body.length() == 4 && "audio/webm".equals(body.optString("mime")) && integral(body.opt("byteLength"), 1, 262144) && integral(body.opt("durationMs"), 0, 120000)) return;
        } else if ("part".equals(action)) {
            if (body.length() == 4 && text(body.opt("uploadId"), ID) && integral(body.opt("seq"), 0, 511) && text(body.opt("data"), PART)) return;
        } else if (("end".equals(action) || "cancel".equals(action)) && body.length() == 2 && text(body.opt("uploadId"), ID)) return;
        throw new SecurityException("Voice command is malformed.");
    }
    private static void lists(JSONObject body) {
        if (body.length() != 4 || !integral(body.opt("expectedRevision"), 0, Long.MAX_VALUE) || !text(body.opt("listId"), ID)) throw new SecurityException("List change is malformed.");
        String action = body.optString("action");
        if ("add".equals(action)) {
            if (body.opt("item") instanceof JSONObject && !body.has("itemId") && body.opt("item").toString().length() <= 4096) return;
        } else if (("toggle".equals(action) || "remove".equals(action)) && text(body.opt("itemId"), ID) && !body.has("item")) return;
        throw new SecurityException("List change is malformed.");
    }
    private static boolean text(Object value, String pattern) { return value instanceof String && ((String) value).matches(pattern); }
    private static boolean integral(Object value, long min, long max) {
        if (!(value instanceof Integer || value instanceof Long)) return false;
        long number = ((Number) value).longValue();
        return number >= min && number <= max;
    }
}
