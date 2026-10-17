package com.displayos.kiosk;

import org.json.JSONObject;

public final class DeviceCommandPolicyTest {
    private static int passed;
    static void check(boolean accepted) { if (!accepted) throw new AssertionError(); }
    static void test(String name, Runnable action) { action.run(); passed++; System.out.println("PASS " + name); }
    static JSONObject body(String json) { try { return new JSONObject(json); } catch (Exception error) { throw new AssertionError(error); } }
    static void accept(String path, String json) { DeviceCommandPolicy.check(path, body(json)); }
    static void reject(String path, String json) {
        try { DeviceCommandPolicy.check(path, body(json)); } catch (SecurityException expected) { return; }
        throw new AssertionError("Missing rejection: " + json);
    }
    public static void main(String[] args) {
        test("empty bodies stay allowed only where the screen sends none", () -> {
            accept("/device/v1/erase", "{}");
            accept("/device/v1/pairing", "{}");
            reject("/device/v1/pairing", "{\"code\":\"123456\"}");
        });
        test("voice begin accepts only the exact recording shape", () -> {
            accept("/device/v1/voice", "{\"action\":\"begin\",\"mime\":\"audio/webm\",\"byteLength\":4096,\"durationMs\":4200}");
            reject("/device/v1/voice", "{\"action\":\"begin\",\"mime\":\"audio/wav\",\"byteLength\":4096,\"durationMs\":4200}");
            reject("/device/v1/voice", "{\"action\":\"begin\",\"mime\":\"audio/webm\",\"byteLength\":0,\"durationMs\":4200}");
            reject("/device/v1/voice", "{\"action\":\"begin\",\"mime\":\"audio/webm\",\"byteLength\":262145,\"durationMs\":4200}");
            reject("/device/v1/voice", "{\"action\":\"begin\",\"mime\":\"audio/webm\",\"byteLength\":4096,\"durationMs\":120001}");
            reject("/device/v1/voice", "{\"action\":\"begin\",\"mime\":\"audio/webm\",\"byteLength\":4096}");
            reject("/device/v1/voice", "{\"action\":\"begin\",\"mime\":\"audio/webm\",\"byteLength\":4096,\"durationMs\":4200,\"extra\":1}");
        });
        test("voice part accepts one bounded base64 chunk", () -> {
            accept("/device/v1/voice", "{\"action\":\"part\",\"uploadId\":\"AbCdEfGhIjKlMnOpQr\",\"seq\":0,\"data\":\"AAAA\"}");
            reject("/device/v1/voice", "{\"action\":\"part\",\"uploadId\":\"AbCdEfGhIjKlMnOpQr\",\"seq\":0,\"data\":\"AA!A\"}");
            reject("/device/v1/voice", "{\"action\":\"part\",\"uploadId\":\"AbCdEfGhIjKlMnOpQr\",\"seq\":512,\"data\":\"AAAA\"}");
            reject("/device/v1/voice", "{\"action\":\"part\",\"uploadId\":\"AbCdEfGhIjKlMnOpQr\",\"seq\":0.5,\"data\":\"AAAA\"}");
            reject("/device/v1/voice", "{\"action\":\"part\",\"uploadId\":\"bad/id\",\"seq\":0,\"data\":\"AAAA\"}");
            reject("/device/v1/voice", "{\"action\":\"part\",\"uploadId\":\"AbCdEfGhIjKlMnOpQr\",\"seq\":0,\"data\":\"\"}");
            StringBuilder oversized = new StringBuilder();
            for (int index = 0; index < 5601; index++) oversized.append('A');
            reject("/device/v1/voice", "{\"action\":\"part\",\"uploadId\":\"AbCdEfGhIjKlMnOpQr\",\"seq\":1,\"data\":\"" + oversized + "\"}");
        });
        test("voice end and cancel accept only the upload id", () -> {
            accept("/device/v1/voice", "{\"action\":\"end\",\"uploadId\":\"AbCdEfGhIjKlMnOpQr\"}");
            accept("/device/v1/voice", "{\"action\":\"cancel\",\"uploadId\":\"AbCdEfGhIjKlMnOpQr\"}");
            reject("/device/v1/voice", "{\"action\":\"end\",\"uploadId\":\"AbCdEfGhIjKlMnOpQr\",\"seq\":0}");
            reject("/device/v1/voice", "{\"action\":\"cancel\"}");
        });
        test("unknown voice actions are rejected", () -> {
            reject("/device/v1/voice", "{\"action\":\"upload\",\"uploadId\":\"AbCdEfGhIjKlMnOpQr\"}");
            reject("/device/v1/voice", "{\"uploadId\":\"AbCdEfGhIjKlMnOpQr\"}");
        });
        test("list changes accept exact add, toggle and remove shapes", () -> {
            accept("/device/v1/lists", "{\"expectedRevision\":3,\"listId\":\"groceries\",\"action\":\"add\",\"item\":{\"id\":\"milk1\",\"label\":\"Milk\"}}");
            accept("/device/v1/lists", "{\"expectedRevision\":3,\"listId\":\"groceries\",\"action\":\"toggle\",\"itemId\":\"milk1\"}");
            accept("/device/v1/lists", "{\"expectedRevision\":3,\"listId\":\"groceries\",\"action\":\"remove\",\"itemId\":\"milk1\"}");
        });
        test("list changes reject malformed shapes", () -> {
            reject("/device/v1/lists", "{\"expectedRevision\":-1,\"listId\":\"groceries\",\"action\":\"toggle\",\"itemId\":\"milk1\"}");
            reject("/device/v1/lists", "{\"expectedRevision\":1.5,\"listId\":\"groceries\",\"action\":\"toggle\",\"itemId\":\"milk1\"}");
            reject("/device/v1/lists", "{\"expectedRevision\":3,\"listId\":\"groceries\",\"action\":\"wipe\",\"itemId\":\"milk1\"}");
            reject("/device/v1/lists", "{\"expectedRevision\":3,\"listId\":\"groceries\",\"action\":\"add\",\"item\":\"milk\"}");
            reject("/device/v1/lists", "{\"expectedRevision\":3,\"listId\":\"groceries\",\"action\":\"add\",\"item\":{\"id\":\"milk1\"},\"itemId\":\"milk1\"}");
            reject("/device/v1/lists", "{\"expectedRevision\":3,\"listId\":\"groceries\",\"action\":\"toggle\"}");
            reject("/device/v1/lists", "{\"expectedRevision\":3,\"listId\":\"groceries\",\"action\":\"toggle\",\"itemId\":\"milk1\",\"item\":{\"id\":\"milk1\"}}");
            reject("/device/v1/lists", "{\"expectedRevision\":3,\"listId\":\"\",\"action\":\"toggle\",\"itemId\":\"milk1\"}");
            reject("/device/v1/lists", "{\"expectedRevision\":3,\"listId\":\"groceries\",\"action\":\"toggle\",\"itemId\":\"milk1\",\"extra\":1}");
            StringBuilder huge = new StringBuilder();
            for (int index = 0; index < 4200; index++) huge.append('x');
            reject("/device/v1/lists", "{\"expectedRevision\":3,\"listId\":\"groceries\",\"action\":\"add\",\"item\":{\"id\":\"milk1\",\"label\":\"" + huge + "\"}}");
        });
        System.out.println(passed + " device command policy checks passed.");
    }
}
