package com.displayos.kiosk;

import org.json.JSONArray;
import org.json.JSONObject;

public final class LocalContentTest {
    private static final long NOW = 1791620096501L;
    private static int passed;
    private static void check(boolean condition) { if (!condition) throw new AssertionError(); }
    private static void test(String name, NativeProtocolTest.Action action) throws Exception { action.run(); passed++; System.out.println("PASS " + name); }
    private static JSONObject fixture(long expiresAt) throws Exception {
        return new JSONObject().put("available", true).put("localEnabled", new JSONObject().put("weather", true).put("nearby", true)).put("localRevision", 3).put("cityLabel", "Synthetic town").put("weather", new JSONArray()).put("nearby", new JSONArray()).put("attribution", "Google Maps").put("thirdPartyAttributions", new JSONArray()).put("expiresAt", expiresAt).put("ephemeral", true);
    }
    private static JSONObject sanitize(JSONObject input, long now) throws Exception { return new JSONObject(LocalContent.sanitize(input.toString(), now)); }
    public static void main(String[] args) throws Exception {
        test("local one hour expiry is accepted unchanged", () -> check(sanitize(fixture(NOW + 3600000L), NOW).getLong("expiresAt") == NOW + 3600000L));
        test("observed 2500ms clock lag is accepted and clamped to one hour", () -> { JSONObject result = sanitize(fixture(NOW + 3600000L), NOW - 2500L); check(result.getLong("expiresAt") == NOW - 2500L + 3600000L); });
        test("exact 30 second upper skew is accepted and clamped", () -> check(sanitize(fixture(NOW + 3630000L), NOW).getLong("expiresAt") == NOW + 3600000L));
        test("over 30 seconds upper skew fails closed", () -> NativeProtocolTest.reject(() -> sanitize(fixture(NOW + 3630001L), NOW)));
        test("expiry at current time and already expired remain denied", () -> { NativeProtocolTest.reject(() -> sanitize(fixture(NOW), NOW)); NativeProtocolTest.reject(() -> sanitize(fixture(NOW - 1), NOW)); });
        test("short upstream expiry is never extended", () -> check(sanitize(fixture(NOW + 15000L), NOW).getLong("expiresAt") == NOW + 15000L));
        test("ahead clock never extends server authority", () -> check(sanitize(fixture(NOW + 3600000L), NOW + 2500L).getLong("expiresAt") == NOW + 3600000L));
        test("disabled response preserves metadata without content expiry", () -> { JSONObject input = new JSONObject().put("available", false).put("localEnabled", new JSONObject().put("weather", false).put("nearby", false)).put("localRevision", 4); JSONObject result = sanitize(input, NOW); check(!result.getBoolean("available") && result.getLong("localRevision") == 4 && !result.has("expiresAt") && result.getJSONArray("weather").length() == 0); });
        test("weather and nearby metadata remain intact after clamp", () -> { JSONObject input = fixture(NOW + 3602500L); input.put("weather", new JSONArray().put(new JSONObject().put("date", "2026-10-10").put("label", "Sat").put("high", 20).put("low", 10).put("condition", "Clear"))); input.put("nearby", new JSONArray().put(new JSONObject().put("title", "Synthetic park").put("when", "Park"))); input.put("weatherSourceAttribution", "Source: Includes weather data from Google"); JSONObject result = sanitize(input, NOW); check(result.getJSONArray("weather").length() == 1 && result.getJSONArray("nearby").length() == 1 && result.getLong("localRevision") == 3 && result.getJSONObject("localEnabled").getBoolean("weather") && result.getLong("expiresAt") == NOW + 3600000L); });
        test("skew allowance does not admit extra private fields", () -> NativeProtocolTest.reject(() -> sanitize(fixture(NOW + 3602500L).put("address", "Synthetic prohibited field"), NOW)));
        test("skew allowance does not relax ephemeral or attribution guards", () -> { NativeProtocolTest.reject(() -> sanitize(fixture(NOW + 3602500L).put("ephemeral", false), NOW)); NativeProtocolTest.reject(() -> sanitize(fixture(NOW + 3602500L).put("attribution", "Other"), NOW)); });
        test("skew allowance preserves type and safe integer guards", () -> { NativeProtocolTest.reject(() -> sanitize(fixture(NOW + 3602500L).put("expiresAt", "1791623699001"), NOW)); NativeProtocolTest.reject(() -> sanitize(fixture(NOW + 3602500L).put("expiresAt", NOW + 3602500.5), NOW)); });
        System.out.println("Android JSONObject local-content regressions: " + passed + " passed. Injected synthetic time and content only; no tablet or private data.");
    }
}
