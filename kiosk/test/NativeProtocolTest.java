package com.displayos.kiosk;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Principal;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;

public final class NativeProtocolTest {
    interface Action { void run() throws Exception; }
    private static int passed;
    private static final Protocol protocol = new Protocol("https://example.test");
    static void check(boolean accepted) { if (!accepted) throw new AssertionError(); }
    static void reject(Action action) throws Exception { try { action.run(); } catch (IllegalArgumentException | SecurityException expected) { return; } throw new AssertionError("Missing rejection"); }
    static void test(String name, Action action) throws Exception { action.run(); passed++; System.out.println("PASS " + name); }
    static final class Mock extends HttpsURLConnection {
        int status = 200;
        byte[] payload = "{}".getBytes(StandardCharsets.UTF_8);
        boolean disconnected;
        String mime = "application/json; charset=utf-8";
        final ByteArrayOutputStream sent = new ByteArrayOutputStream();
        Mock(URL url) { super(url); }
        @Override public void disconnect() { disconnected = true; }
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() { }
        @Override public int getResponseCode() { return status; }
        @Override public String getContentType() { return mime; }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(payload); }
        @Override public InputStream getErrorStream() { return new ByteArrayInputStream(payload); }
        @Override public OutputStream getOutputStream() { return sent; }
        @Override public String getCipherSuite() { return "TLS_TEST_ONLY"; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() { return null; }
        @Override public Principal getPeerPrincipal() { return null; }
        @Override public Principal getLocalPrincipal() { return null; }
    }
    public static void main(String[] args) throws Exception {
        test("canonical origin", () -> { reject(() -> new Protocol("http://example.test")); reject(() -> new Protocol("https://example.test/")); reject(() -> new Protocol("https://user@example.test")); reject(() -> new Protocol("https://example.test:443")); });
        test("screen navigation only", () -> { check(protocol.navigation("https://example.test/screen")); check(!protocol.navigation("https://example.test/home")); check(!protocol.navigation("https://example.test.evil/screen")); });
        test("canonical route attacks", () -> { for (String path : Arrays.asList("/device/v1/../v1/poll", "/device//v1/poll", "/device/v1/%70oll", "/device/v1/poll?x=1", "/device/v1/poll#x", "/device\\v1/poll")) check(protocol.path("https://example.test" + path) == null); });
        test("public asset boundary", () -> { check(protocol.publicAsset("/product/screen.js")); check(!protocol.publicAsset("/product/../home")); check(!protocol.publicAsset("/auth/login")); });
        test("device credential route allowlist", () -> { for (String path : Arrays.asList("/device/v1/pairing", "/device/v1/ack", "/device/v1/confirm", "/device/v1/erase")) check(protocol.bearerAllowed(path, "POST")); check(protocol.bearerAllowed("/device/v1/poll", "GET")); check(!protocol.bearerAllowed("/device/v1/recover/start", "POST")); });
        test("media identifier boundary", () -> { check(protocol.mediaId("/device/v1/media/abcdefgh") != null); check(protocol.mediaId("/device/v1/media/abcd%2fgh") == null); check(!protocol.bearerAllowed("/device/v1/media/abcdefgh", "POST")); });
        test("private expiry", () -> { check(Protocol.active(2000, 1000, 1500)); check(!Protocol.active(2000, 1000, 2000)); check(!Protocol.active(1000, 1000, 900)); });
        test("ttl and clock rollback", () -> { check(!Protocol.active(86401001, 1000, 1000)); check(!Protocol.active(1000000, 400000, 99999)); });
        test("owner pin boundary", () -> { Protocol.requirePin("19482736"); reject(() -> Protocol.requirePin("1234")); reject(() -> Protocol.requirePin("1234567a")); reject(() -> Protocol.requirePin(null)); });
        test("p256 coordinate normalization", () -> { check(SignatureCodec.coordinate(BigInteger.ONE)[31] == 1); check(SignatureCodec.coordinate(BigInteger.ONE.shiftLeft(255)).length == 32); reject(() -> SignatureCodec.coordinate(BigInteger.valueOf(-1))); reject(() -> SignatureCodec.coordinate(BigInteger.ONE.shiftLeft(256))); });
        test("reject malformed der", () -> { reject(() -> SignatureCodec.raw(new byte[0])); reject(() -> SignatureCodec.raw(new byte[] {48,6,2,1,-1,2,1,1})); reject(() -> SignatureCodec.raw(new byte[] {48,6,2,1,1,2,2,1})); });
        test("enrollment and recovery raw signatures verify", () -> {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC"); generator.initialize(new ECGenParameterSpec("secp256r1")); KeyPair unit = generator.generateKeyPair();
            for (int index = 0; index < 32; index++) {
                String message = index % 2 == 0 ? "one-use-ticket-test" : "DisplayOS recovery\nhttps://example.test\nunit-test\nchallenge-test";
                Signature signer = Signature.getInstance("SHA256withECDSA"); signer.initSign(unit.getPrivate()); signer.update(message.getBytes(StandardCharsets.UTF_8)); byte[] raw = SignatureCodec.raw(signer.sign()); check(raw.length == 64);
                Signature verifier = Signature.getInstance("SHA256withECDSAinP1363Format"); verifier.initVerify(unit.getPublic()); verifier.update(message.getBytes(StandardCharsets.UTF_8)); check(verifier.verify(raw));
            }
        });
        test("native HTTP credentials never reach public assets", () -> { NativeHttp http = new NativeHttp(protocol, address -> { throw new AssertionError("Connection must not open"); }); reject(() -> http.send("/product/screen.js", "GET", null, "synthetic-test-token", 100)); reject(() -> http.send("/device/v1/enroll", "POST", "{}", "synthetic-test-token", 100)); });
        test("native HTTP cross origin and traversal denied", () -> { NativeHttp http = new NativeHttp(protocol, address -> { throw new AssertionError(); }); reject(() -> http.send("//evil.test/x", "GET", null, null, 100)); reject(() -> http.send("/device/v1/%70oll", "GET", null, "synthetic-test-token", 100)); });
        test("native HTTP authenticated poll", () -> { Mock mock = new Mock(new URL(protocol.origin())); NativeHttp.Reply reply = new NativeHttp(protocol, address -> mock).send("/device/v1/poll", "GET", null, "synthetic-test-token", 100); check(reply.status == 200); check("Bearer synthetic-test-token".equals(mock.getRequestProperty("Authorization"))); check(!mock.getInstanceFollowRedirects()); check(mock.disconnected); });
        test("native HTTP post carries structured body", () -> { Mock mock = new Mock(new URL(protocol.origin())); new NativeHttp(protocol, address -> mock).send("/device/v1/ack", "POST", "{\"revision\":1,\"nonce\":\"test\"}", "synthetic-test-token", 100); check("POST".equals(mock.getRequestMethod())); check(mock.sent.size() > 0); check("application/json".equals(mock.getRequestProperty("Content-Type"))); });
        test("native HTTP redirect fail closed", () -> { Mock mock = new Mock(new URL(protocol.origin())); mock.status = 302; reject(() -> new NativeHttp(protocol, address -> mock).send("/device/v1/poll", "GET", null, "synthetic-test-token", 100)); check(mock.disconnected); });
        test("native HTTP response bound", () -> { Mock mock = new Mock(new URL(protocol.origin())); mock.payload = new byte[101]; reject(() -> new NativeHttp(protocol, address -> mock).send("/device/v1/poll", "GET", null, "synthetic-test-token", 100)); check(mock.disconnected); });
        test("native HTTP request bound", () -> { Mock mock = new Mock(new URL(protocol.origin())); reject(() -> new NativeHttp(protocol, address -> mock).send("/device/v1/ack", "POST", new String(new char[65537]), "synthetic-test-token", 100)); check(mock.disconnected); });
        test("native HTTP auth errors not converted into success", () -> { Mock mock = new Mock(new URL(protocol.origin())); mock.status = 401; check(new NativeHttp(protocol, address -> mock).send("/device/v1/poll", "GET", null, "synthetic-test-token", 100).status == 401); });
        final String unitId = "native_unit_1234567890";
        test("fresh headless preparation permitted", () -> EnrollmentPolicy.prepare(false, false, null, false, unitId, null));
        test("headless preparation requires factory identity", () -> reject(() -> EnrollmentPolicy.prepare(false, false, null, false, null, null)));
        test("enrolled unit cannot be prepared again", () -> { reject(() -> EnrollmentPolicy.prepare(true, false, null, false, unitId, null)); reject(() -> EnrollmentPolicy.prepare(true, true, unitId, false, unitId, "19482736")); });
        test("headless cannot clear existing PIN", () -> reject(() -> EnrollmentPolicy.prepare(false, true, unitId, true, unitId, null)));
        test("legacy manual PIN remains supported", () -> { EnrollmentPolicy.prepare(false, false, null, false, null, "19482736"); EnrollmentPolicy.prepare(false, true, unitId, false, unitId, "19482736"); });
        test("pending identity remains immutable", () -> { reject(() -> EnrollmentPolicy.prepare(false, false, unitId, true, "another_unit_123456", null)); reject(() -> EnrollmentPolicy.prepare(false, true, unitId, false, "another_unit_123456", "19482736")); });
        test("pending enrollment requires deferred PIN marker", () -> { reject(() -> EnrollmentPolicy.prepare(false, false, unitId, false, unitId, null)); EnrollmentPolicy.prepare(false, false, unitId, true, unitId, null); });
        test("only unclaimed server state permits deferred PIN", () -> { EnrollmentPolicy.unclaimed("unclaimed", false); for (String state : Arrays.asList("owned", "confirm", "erase", "", "blocked")) reject(() -> EnrollmentPolicy.unclaimed(state, false)); reject(() -> EnrollmentPolicy.unclaimed("unclaimed", true)); });
        test("recovery preserves PIN except known owner reset", () -> { check(!EnrollmentPolicy.clearPinAfterRecovery(false, "unclaimed")); check(!EnrollmentPolicy.clearPinAfterRecovery(true, "owned")); check(EnrollmentPolicy.clearPinAfterRecovery(true, "unclaimed")); });
        test("strict fresh and legacy preparation fields", () -> { Map<String, Object> input = new HashMap<String, Object>(); input.put("ticket", "synthetic-ticket"); input.put("deviceId", unitId); EnrollmentPolicy.fields(input); input.put("ownerPin", "19482736"); EnrollmentPolicy.fields(input); input.put("deviceToken", "synthetic"); reject(() -> EnrollmentPolicy.fields(input)); });
        test("preparation fields reject missing and coerced types", () -> { Map<String, Object> input = new HashMap<String, Object>(); input.put("ticket", "synthetic-ticket"); reject(() -> EnrollmentPolicy.fields(input)); input.put("deviceId", 1234); reject(() -> EnrollmentPolicy.fields(input)); input.put("deviceId", unitId); input.put("ticket", null); reject(() -> EnrollmentPolicy.fields(input)); input.put("ticket", "synthetic-ticket"); input.put("ownerPin", 19482736); reject(() -> EnrollmentPolicy.fields(input)); input.put("ownerPin", null); reject(() -> EnrollmentPolicy.fields(input)); });
        test("explicit empty PIN is not omission", () -> { Map<String, Object> input = new HashMap<String, Object>(); input.put("ticket", "synthetic-ticket"); input.put("deviceId", unitId); input.put("ownerPin", ""); reject(() -> EnrollmentPolicy.fields(input)); reject(() -> EnrollmentPolicy.prepare(false, false, null, false, unitId, "")); });
        test("new PIN requires exactly six numbers", () -> { Protocol.requireNewPin("194827"); for (String pin : Arrays.asList("12345", "1234567", "19482736", "12345a", " 123456", "１２３４５６")) reject(() -> Protocol.requireNewPin(pin)); reject(() -> Protocol.requireNewPin(null)); });
        test("existing six and legacy eight to twelve PINs remain valid", () -> { for (String pin : Arrays.asList("194827", "19482736", "194827361234")) Protocol.requirePin(pin); reject(() -> Protocol.requirePin("1948273")); });
        test("claim bound to phrase and expiry", () -> { check(ClaimPolicy.current("confirm", "test words", 2000, "test words", 2000, 1000)); check(!ClaimPolicy.current("confirm", "other words", 2000, "test words", 2000, 1000)); check(!ClaimPolicy.current("confirm", "test words", 2500, "test words", 2000, 1000)); });
        test("stale missing and nonconfirm claims fail closed", () -> { check(!ClaimPolicy.current("confirm", "words", 1000, "words", 1000, 1000)); check(!ClaimPolicy.current("owned", "words", 2000, "words", 2000, 1000)); check(!ClaimPolicy.current("confirm", "", 2000, "", 2000, 1000)); check(!ClaimPolicy.current("confirm", "words", 200000, "words", 200000, 1000)); });
        test("human claim deadline reserves network time", () -> { check(ClaimPolicy.waitMillis(121000, 1000) == 90000); check(ClaimPolicy.waitMillis(31000, 1000) == 15000); check(ClaimPolicy.waitMillis(11000, 1000) == 0); check(ClaimPolicy.waitMillis(1000, 1000) == 0); });
        test("claim expiry is rechecked after an expensive PIN operation", () -> { check(ClaimPolicy.current("confirm", "words", 3000, "words", 3000, 1000)); check(!ClaimPolicy.current("confirm", "words", 3000, "words", 3000, 3000)); });
        test("local credential route is exact GET only", () -> { check(protocol.deviceGet("/device/v1/local")); check(protocol.bearerAllowed("/device/v1/local", "GET")); for (String method : Arrays.asList("POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")) check(!protocol.bearerAllowed("/device/v1/local", method)); check(!protocol.bearerAllowed("/device/v1/local/", "GET")); });
        test("local URL query traversal encoding and other methods denied", () -> { NativeHttp http = new NativeHttp(protocol, address -> { throw new AssertionError("Connection must not open"); }); for (String path : Arrays.asList("/device/v1/local?x=1", "/device/v1/../v1/local", "/device/v1/%6cocal", "/device//v1/local", "/device/v1/local/", "/device/v1/local#x")) reject(() -> http.send(path, "GET", null, "synthetic-token", 32768)); reject(() -> http.send("/device/v1/local", "POST", "{}", "synthetic-token", 32768)); });
        test("local authenticates exact route without transport secrets in result", () -> { Mock mock = new Mock(new URL(protocol.origin())); mock.payload = "{\"cityLabel\":\"Sample city\",\"weather\":[],\"nearby\":[]}".getBytes(StandardCharsets.UTF_8); NativeHttp http = new NativeHttp(protocol, address -> { check(address.toString().equals("https://example.test/device/v1/local")); return mock; }); NativeHttp.Reply result = http.local("synthetic-token", () -> true); check("GET".equals(mock.getRequestMethod())); check("Bearer synthetic-token".equals(mock.getRequestProperty("Authorization"))); check(!result.text().contains("synthetic-token")); check(mock.sent.size() == 0); check(!mock.getUseCaches()); });
        test("local denied ownership or missing credential does not connect", () -> { NativeHttp http = new NativeHttp(protocol, address -> { throw new AssertionError(); }); reject(() -> http.local("synthetic-token", () -> false)); reject(() -> http.local(null, () -> true)); });
        test("local ownership change during fetch drops response", () -> { Mock mock = new Mock(new URL(protocol.origin())); java.util.concurrent.atomic.AtomicInteger checks = new java.util.concurrent.atomic.AtomicInteger(); reject(() -> new NativeHttp(protocol, address -> mock).local("synthetic-token", () -> checks.incrementAndGet() == 1)); check(checks.get() == 2); });
        test("local response maximum is exactly 32 KiB", () -> { Mock mock = new Mock(new URL(protocol.origin())); mock.payload = new byte[32768]; check(new NativeHttp(protocol, address -> mock).local("synthetic-token", () -> true).data.length == 32768); Mock tooLarge = new Mock(new URL(protocol.origin())); tooLarge.payload = new byte[32769]; reject(() -> new NativeHttp(protocol, address -> tooLarge).local("synthetic-token", () -> true)); });
        test("local server rejects stay rejects without upstream error contents", () -> { for (int status : new int[] {401,403,404,429,503}) { Mock mock = new Mock(new URL(protocol.origin())); mock.status = status; mock.payload = "{\"deviceToken\":\"synthetic-private\",\"address\":\"synthetic-private\"}".getBytes(StandardCharsets.UTF_8); NativeHttp.Reply result = new NativeHttp(protocol, address -> mock).local("synthetic-token", () -> true); check(result.status == status); check("{}".equals(result.text())); } });
        test("local never falls back on offline failure", () -> { java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger(); NativeHttp http = new NativeHttp(protocol, address -> { calls.incrementAndGet(); throw new java.io.IOException("synthetic offline"); }); boolean failed = false; try { http.local("synthetic-token", () -> true); } catch (java.io.IOException expected) { failed = true; } check(failed && calls.get() == 1); });
        test("local rejects HTML and redirects", () -> { Mock html = new Mock(new URL(protocol.origin())); html.mime = "text/html"; reject(() -> new NativeHttp(protocol, address -> html).local("synthetic-token", () -> true)); Mock redirected = new Mock(new URL(protocol.origin())); redirected.status = 302; reject(() -> new NativeHttp(protocol, address -> redirected).local("synthetic-token", () -> true)); });
        test("local has a native-only 35 second read budget", () -> { Mock local = new Mock(new URL(protocol.origin())); new NativeHttp(protocol, address -> local).local("synthetic-token", () -> true); check(local.getReadTimeout() == 35000); check(local.getConnectTimeout() == 8000); Mock poll = new Mock(new URL(protocol.origin())); new NativeHttp(protocol, address -> poll).send("/device/v1/poll", "GET", null, "synthetic-token", 100); check(poll.getReadTimeout() == 8000); });
        test("longer read budget cannot escape the authenticated local GET", () -> { NativeHttp http = new NativeHttp(protocol, address -> { throw new AssertionError(); }); reject(() -> http.send("/device/v1/poll", "GET", null, "synthetic-token", 100, 35000)); reject(() -> http.send("/device/v1/local", "POST", "{}", "synthetic-token", 100, 35000)); reject(() -> http.send("/device/v1/local", "GET", null, null, 100, 35000)); reject(() -> http.send("/device/v1/local", "GET", null, "synthetic-token", 100, 35001)); });
        test("35 second budget rejects route lookalikes and alternative methods before HTTP", () -> { NativeHttp http = new NativeHttp(protocol, address -> { throw new AssertionError(); }); for (String path : new String[] {"/device/v1/local/", "/device/v1/local?x=1", "/device/v1/%6cocal", "/device/v1/../local", "/device/v1/media/synthetic"}) reject(() -> http.send(path, "GET", null, "synthetic-token", 100, 35000)); for (String method : new String[] {"HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"}) reject(() -> http.send("/device/v1/local", method, null, "synthetic-token", 100, 35000)); });
        test("initialization reload invalidates queued startup completion", () -> { InitializationGate gate = new InitializationGate(); int startup = gate.begin(); Runnable stale = () -> check(!gate.current(startup)); int reload = gate.begin(); stale.run(); check(gate.current(reload)); });
        test("multiple reloads only permit the newest candidate", () -> { InitializationGate gate = new InitializationGate(); int first = gate.begin(); int second = gate.begin(); int third = gate.begin(); check(!gate.current(first)); check(!gate.current(second)); check(gate.current(third)); });
        test("destroy invalidates construction and queued UI completion", () -> { InitializationGate gate = new InitializationGate(); int epoch = gate.begin(); gate.destroy(); check(!gate.current(epoch)); gate.destroy(); check(!gate.current(epoch)); });
        test("destroyed initialization cannot restart", () -> { InitializationGate gate = new InitializationGate(); gate.destroy(); boolean rejected = false; try { gate.begin(); } catch (IllegalStateException expected) { rejected = true; } check(rejected); });
        test("stale and destroyed candidates cannot replace the active candidate", () -> { InitializationGate gate = new InitializationGate(); Object[] active = new Object[1]; Object startup = new Object(); Object reload = new Object(); int first = gate.begin(); Runnable stale = () -> { if (gate.current(first)) active[0] = startup; }; int second = gate.begin(); Runnable fresh = () -> { if (gate.current(second)) active[0] = reload; }; stale.run(); check(active[0] == null); fresh.run(); stale.run(); check(active[0] == reload); gate.destroy(); active[0] = null; fresh.run(); check(active[0] == null); });
        System.out.println("Native protocol tests: " + passed + " passed. Mock transport only; no Android runtime or tablet proof.");
    }
}
