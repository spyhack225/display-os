package com.displayos.kiosk;

import org.json.JSONObject;

public final class SnapshotStateTest {
    private static int passed;
    private static void check(boolean condition) { if (!condition) throw new AssertionError(); }
    private static void test(String name, NativeProtocolTest.Action action) throws Exception { action.run(); passed++; System.out.println("PASS " + name); }
    private static JSONObject emptyOwned() throws Exception { return new JSONObject("{\"state\":\"owned\",\"snapshot\":null,\"revision\":0,\"expiresAt\":900}"); }
    private static JSONObject content() throws Exception { return new JSONObject("{\"state\":\"owned\",\"snapshot\":{\"schemaVersion\":1,\"expiresAt\":3000},\"expiresAt\":3000}"); }
    public static void main(String[] args) throws Exception {
        test("real Android JSONObject reproduces the null-key bug", () -> { JSONObject state = emptyOwned(); check(state.has("snapshot")); check(state.opt("snapshot") == JSONObject.NULL); check(state.optJSONObject("snapshot") == null); });
        test("owned JSON null has no content and no expiry", () -> { JSONObject state = emptyOwned(); check(!SnapshotState.hasSnapshot(state)); check(SnapshotState.expiry(state, 0, 1000, 0, 1000) == 0); });
        test("missing snapshot and missing latest have no expiry", () -> { check(!SnapshotState.hasSnapshot(null)); check(!SnapshotState.hasSnapshot(new JSONObject("{\"state\":\"owned\"}"))); check(SnapshotState.expiry(null, 0, 1000, 0, 1000) == 0); });
        test("one hundred repeated owned null polls never trigger content erasure", () -> { JSONObject previous = null; int erasures = 0; for (int index = 0; index < 100; index++) { JSONObject next = emptyOwned(); if (SnapshotState.contentRemoved(previous, next)) erasures++; check(SnapshotState.expiry(next, 0, 1000 + index, 0, 1000 + index) == 0); previous = next; } check(erasures == 0); });
        test("real content removed then repeated null polls erase exactly once", () -> { JSONObject previous = content(); int erasures = 0; for (int index = 0; index < 100; index++) { JSONObject next = emptyOwned(); if (SnapshotState.contentRemoved(previous, next)) erasures++; previous = next; } check(erasures == 1); });
        test("real future snapshot retains its expiry", () -> check(SnapshotState.expiry(content(), 2000, 1000, 1000, 1500) == 3000));
        test("real expired content fails closed before settling to owned null", () -> { JSONObject previous = content(); check(SnapshotState.expiry(previous, 2000, 1000, 1000, 3000) == 1); JSONObject next = emptyOwned(); check(SnapshotState.contentRemoved(previous, next)); check(SnapshotState.expiry(next, 0, 1000, 0, 3000) == 0); check(!SnapshotState.contentRemoved(next, emptyOwned())); });
        test("real monotonic deadline and clock rollback remain fail closed", () -> { check(SnapshotState.expiry(content(), 1000, 1000, 1000, 1500) == 1); check(SnapshotState.expiry(content(), 2000, 1000, 400000, 99999) == 1); });
        test("null content cannot qualify an ACK", () -> { check(!SnapshotState.hasSnapshot(emptyOwned())); check(SnapshotState.hasSnapshot(content())); });
        test("unclaimed explicit null remains valid but actual content is denied", () -> { EnrollmentPolicy.unclaimed("unclaimed", SnapshotState.hasSnapshot(new JSONObject("{\"state\":\"unclaimed\",\"snapshot\":null}"))); NativeProtocolTest.reject(() -> EnrollmentPolicy.unclaimed("unclaimed", SnapshotState.hasSnapshot(content()))); });
        test("primitive and array snapshots fail closed", () -> { for (String value : new String[] {"[]", "true", "0", "\"text\""}) NativeProtocolTest.reject(() -> SnapshotState.hasSnapshot(new JSONObject("{\"snapshot\":" + value + "}"))); });
        System.out.println("Android 8.1 JSONObject snapshot regressions: " + passed + " passed. Synthetic fixtures only; no vault or tablet access.");
    }
}
