package com.displayos.kiosk;

import android.content.Context;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashSet;
import java.util.Set;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

public final class NativeClient {
    public interface Observer { void changed(JSONObject state); void erased(); }
    private final Vault vault;
    private final Identity identity;
    private final Protocol protocol;
    private final NativeHttp http;
    private final File informationFile;
    private JSONObject configuration;
    private volatile JSONObject latest;
    private long ownedPollAt;
    private long contentDeadline;
    private long contentFetchedAt;
    private final Set<String> approvedMedia = new HashSet<String>();
    private Observer observer;
    public NativeClient(Context context, Protocol protocol) throws Exception {
        this.protocol = protocol; vault = new Vault(context); identity = new Identity(); http = new NativeHttp(protocol);
        informationFile = new File(context.getFilesDir(), "unit-info.json");
        byte[] saved = vault.get("configuration");
        configuration = saved == null ? new JSONObject() : new JSONObject(new String(saved, StandardCharsets.UTF_8));
        if (configuration.has("origin") && !configuration.getString("origin").equals(protocol.origin())) throw new SecurityException("Configured service origin changed. Reprovision locally.");
        try (FileOutputStream output = new FileOutputStream(new File(context.getFilesDir(), "public-key.json"))) { output.write(identity.publicKey().toString().getBytes(StandardCharsets.UTF_8)); }
        writeInformation();
        if (configuration.optBoolean("contentDenied")) vault.clearContent();
        byte[] cached = vault.get("poll");
        if (cached != null) {
            JSONObject record = new JSONObject(new String(cached, StandardCharsets.UTF_8));
            if (Protocol.active(record.getLong("expiresAt"), record.getLong("fetchedAt"), System.currentTimeMillis())) acceptPoll(record.getJSONObject("state"), false);
            else vault.clearContent();
        }
    }
    public synchronized void observe(Observer value) { observer = value; }
    public synchronized boolean prepared() { return configuration.has("deviceToken"); }
    public synchronized boolean hasPin() { return configuration.has("pinHash"); }
    public synchronized long pinRetryAfterMillis() { return Math.max(0L, configuration.optLong("pinBlockedUntil") - System.currentTimeMillis()); }
    private String cacheName(String prefix, String path) throws Exception { return prefix + Identity.encode(MessageDigest.getInstance("SHA-256").digest(path.getBytes(StandardCharsets.UTF_8))); }
    public String publicKey() throws Exception { return identity.publicKey().toString(); }
    public boolean hardwareBacked() throws Exception { return identity.hardwareBacked(); }
    private void writeInformation() throws Exception {
        JSONObject information = new JSONObject().put("origin", protocol.origin()).put("prepared", prepared()).put("hardwareBacked", identity.hardwareBacked());
        android.util.AtomicFile target = new android.util.AtomicFile(informationFile); FileOutputStream output = target.startWrite();
        try { output.write(information.toString().getBytes(StandardCharsets.UTF_8)); target.finishWrite(output); } catch (Exception error) { target.failWrite(output); throw error; }
    }
    private void save() throws Exception { vault.put("configuration", configuration.toString().getBytes(StandardCharsets.UTF_8)); writeInformation(); }
    private static byte[] pinHash(String pin, byte[] salt) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(), salt, 120000, 256);
        try { return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded(); } finally { spec.clearPassword(); }
    }
    public synchronized void setPin(String pin) throws Exception {
        Protocol.requireNewPin(pin); storePin(pin);
    }
    private synchronized void storePin(String pin) throws Exception {
        storePin(pin, () -> true);
    }
    private synchronized void storePin(String pin, java.util.function.BooleanSupplier permitted) throws Exception {
        if (configuration.has("pinHash") || configuration.has("pinSalt")) throw new SecurityException("An existing owner PIN cannot be replaced by preparation.");
        Protocol.requirePin(pin); byte[] salt = new byte[16]; new SecureRandom().nextBytes(salt);
        byte[] hash = pinHash(pin, salt);
        JSONObject updated = new JSONObject(configuration.toString());
        updated.put("pinSalt", Identity.encode(salt)).put("pinHash", Identity.encode(hash)).put("pinFailures", 0).put("pinBlockedUntil", 0);
        if (!permitted.getAsBoolean()) throw new SecurityException("PIN commit is no longer authorized.");
        vault.put("configuration", updated.toString().getBytes(StandardCharsets.UTF_8));
        configuration = updated; writeInformation();
    }
    private boolean currentClaim(String phrase, long expiresAt) {
        return latest != null && ClaimPolicy.current(latest.optString("state"), latest.optString("phrase"), latest.optLong("expiresAt"), phrase, expiresAt, System.currentTimeMillis());
    }
    public synchronized boolean verifyClaimPin(String pin, String phrase, long expiresAt, java.util.function.BooleanSupplier permitted) throws Exception {
        if (!permitted.getAsBoolean() || !currentClaim(phrase, expiresAt)) throw new SecurityException("Claim expired or changed.");
        boolean accepted;
        if (!hasPin()) {
            Protocol.requireNewPin(pin);
            storePin(pin, () -> permitted.getAsBoolean() && currentClaim(phrase, expiresAt)); accepted = true;
        } else accepted = verifyPin(pin);
        if (!permitted.getAsBoolean() || !currentClaim(phrase, expiresAt)) throw new SecurityException("Claim expired during PIN verification.");
        return accepted;
    }
    public synchronized boolean verifyPin(String pin) throws Exception {
        long now = System.currentTimeMillis();
        if (configuration.optLong("pinBlockedUntil") > now) throw new SecurityException("Owner controls are temporarily locked. Wait before retrying.");
        if (!configuration.has("pinHash")) return false;
        byte[] salt = Base64.decode(configuration.getString("pinSalt"), Base64.URL_SAFE | Base64.NO_WRAP);
        byte[] expected = Base64.decode(configuration.getString("pinHash"), Base64.URL_SAFE | Base64.NO_WRAP);
        boolean accepted = ClaimPolicy.pinFormat(pin) && MessageDigest.isEqual(expected, pinHash(pin, salt));
        int failures = accepted ? 0 : configuration.optInt("pinFailures") + 1;
        configuration.put("pinFailures", failures);
        if (failures >= 5) configuration.put("pinBlockedUntil", now + Math.min(900000L, 60000L << Math.min(4, failures - 5)));
        if (accepted) configuration.put("pinBlockedUntil", 0);
        save(); return accepted;
    }
    public synchronized void prepare(String ticket, String pin) throws Exception {
        prepare(ticket, pin, null);
    }
    public synchronized void prepare(String ticket, String pin, String deviceId) throws Exception {
        String pendingId = configuration.has("deviceId") ? configuration.getString("deviceId") : null;
        EnrollmentPolicy.prepare(prepared(), configuration.has("pinHash") || configuration.has("pinSalt"), pendingId, configuration.optBoolean("deferredPinEnrollment"), deviceId, pin);
        if (ticket == null || ticket.length() < 20 || ticket.length() > 4096 || !ticket.matches("[A-Za-z0-9_.-]+")) throw new IllegalArgumentException("Invalid one-use factory ticket.");
        if (pin != null && hasPin() && !verifyPin(pin)) throw new SecurityException("Existing owner PIN does not match.");
        configuration.put("origin", protocol.origin());
        if (deviceId != null) {
            if (!deviceId.matches("[A-Za-z0-9_-]{16,128}")) throw new SecurityException("Invalid factory unit identifier.");
            if (configuration.has("deviceId") && !deviceId.equals(configuration.getString("deviceId"))) throw new SecurityException("Another factory identity is pending. Recover it rather than cloning this unit.");
            configuration.put("deviceId", deviceId);
        }
        if (pin == null) configuration.put("deferredPinEnrollment", true);
        else if (!hasPin()) storePin(pin);
        save();
        JSONObject request = new JSONObject().put("ticket", ticket).put("publicKey", identity.publicKey()).put("signature", identity.signTicket(ticket));
        NativeHttp.Reply response = http.send("/device/v1/enroll", "POST", request.toString(), null, 65536);
        if (response.status != 200 && response.status != 201) throw new SecurityException("Enrollment refused. Verify the per-unit ticket and matching public key.");
        JSONObject enrolled = new JSONObject(response.text());
        String expectedId = deviceId == null ? pendingId : deviceId;
        if (expectedId != null && !expectedId.equals(enrolled.getString("deviceId"))) throw new SecurityException("Enrollment returned another unit identity.");
        String token = enrolled.getString("deviceToken");
        if (!token.matches("[A-Za-z0-9_-]{32,256}")) throw new SecurityException("Invalid transport credential response.");
        if (configuration.optBoolean("deferredPinEnrollment")) verifyUnclaimed(token);
        configuration.put("deviceId", enrolled.getString("deviceId")).put("deviceToken", token);
        configuration.remove("deferredPinEnrollment"); save();
    }
    private void verifyUnclaimed(String credential) throws Exception {
        NativeHttp.Reply response = http.send("/device/v1/poll", "GET", null, credential, 131072);
        if (response.status != 200) throw new SecurityException("Cannot verify fresh unclaimed enrollment.");
        JSONObject state = new JSONObject(response.text());
        EnrollmentPolicy.unclaimed(state.optString("state"), SnapshotState.hasSnapshot(state));
    }
    public synchronized void resumePending() {
        if (prepared() || !configuration.has("deviceId")) return;
        try { recover(); } catch (Exception ignored) { }
    }
    private synchronized String token() throws Exception {
        if (!prepared()) throw new SecurityException("Screen is not prepared.");
        return configuration.getString("deviceToken");
    }
    public JSONObject state() { return latest; }
    public long expiry() {
        JSONObject current = latest;
        if (!SnapshotState.hasSnapshot(current)) return 0;
        synchronized (this) {
            return SnapshotState.expiry(latest, contentDeadline, android.os.SystemClock.elapsedRealtime(), contentFetchedAt, System.currentTimeMillis());
        }
    }
    private synchronized void recover() throws Exception {
        denyContent();
        vault.clearContent(); latest = null; approvedMedia.clear();
        String deviceId = configuration.getString("deviceId");
        JSONObject request = new JSONObject().put("deviceId", deviceId).put("publicKey", identity.publicKey());
        NativeHttp.Reply start = http.send("/device/v1/recover/start", "POST", request.toString(), null, 65536);
        if (start.status != 200) throw new SecurityException("Device key recovery was refused.");
        JSONObject challenge = new JSONObject(start.text()); String nonce = challenge.getString("challenge");
        String expected = "DisplayOS recovery\n" + protocol.origin() + "\n" + deviceId + "\n" + nonce;
        if (!nonce.matches("[A-Za-z0-9_-]{20,256}") || !expected.equals(challenge.getString("message"))) throw new SecurityException("Recovery challenge is not bound to this service and unit.");
        JSONObject proof = new JSONObject().put("deviceId", deviceId).put("challenge", nonce).put("signature", identity.signMessage(expected));
        NativeHttp.Reply result = http.send("/device/v1/recover/verify", "POST", proof.toString(), null, 65536);
        if (result.status != 200) throw new SecurityException("Device key recovery proof was refused.");
        JSONObject recovered = new JSONObject(result.text()); String credential = recovered.getString("deviceToken");
        if (!credential.matches("[A-Za-z0-9_-]{32,256}") || !deviceId.equals(recovered.getString("deviceId"))) throw new SecurityException("Recovery result is invalid.");
        if (configuration.optBoolean("deferredPinEnrollment")) {
            EnrollmentPolicy.unclaimed(recovered.optString("state"), SnapshotState.hasSnapshot(recovered));
            verifyUnclaimed(credential);
        }
        configuration.put("deviceToken", credential);
        if (EnrollmentPolicy.clearPinAfterRecovery(configuration.optBoolean("resetPending"), recovered.optString("state"))) {
            configuration.remove("pinSalt"); configuration.remove("pinHash");
            configuration.put("pinFailures", 0).put("pinBlockedUntil", 0);
            configuration.remove("resetPending");
        }
        configuration.remove("deferredPinEnrollment");
        save();
    }
    private synchronized void denyContent() throws Exception {
        ownedPollAt = 0;
        if (!configuration.optBoolean("contentDenied")) { configuration.put("contentDenied", true); save(); }
        approvedMedia.clear();
    }
    private synchronized void acceptPoll(JSONObject state, boolean persist) throws Exception {
        if (state.has("deviceToken") || state.has("ticket")) throw new SecurityException("Transport secrets must not appear in renderer state.");
        JSONObject snapshot = SnapshotState.snapshot(state);
        if (snapshot != null) {
            long now = System.currentTimeMillis(); long expires = state.optLong("expiresAt", snapshot.getLong("expiresAt"));
            if (!Protocol.active(expires, now, now) || snapshot.optInt("schemaVersion") != 1) throw new SecurityException("Expired or unsupported snapshot.");
            if (persist || contentDeadline == 0) { contentDeadline = android.os.SystemClock.elapsedRealtime() + expires - now; contentFetchedAt = now; }
            state.put("expiresAt", expires); approvedMedia.clear();
            JSONArray photos = snapshot.optJSONArray("photos");
            if (photos != null) for (int index = 0; index < photos.length() && index < 10; index++) approvedMedia.add(photos.getString(index));
            Set<String> names = new HashSet<String>(); for (String id : approvedMedia) names.add(cacheName("photo-", id)); vault.retain("photo-", names);
            if (persist) vault.put("poll", new JSONObject().put("state", state).put("expiresAt", expires).put("fetchedAt", now).toString().getBytes(StandardCharsets.UTF_8));
            if (configuration.optBoolean("contentDenied")) { configuration.put("contentDenied", false); save(); }
        } else {
            boolean visible = SnapshotState.contentRemoved(latest, state); denyContent(); latest = null;
            if (visible && observer != null) observer.erased();
            approvedMedia.clear(); contentDeadline = 0; vault.clearContent();
        }
        latest = state;
        ownedPollAt = persist && "owned".equals(state.optString("state")) && !state.optBoolean("offline") ? android.os.SystemClock.elapsedRealtime() : 0;
        if (observer != null) observer.changed(state);
    }
    private synchronized boolean localAllowed(String credential) {
        long age = android.os.SystemClock.elapsedRealtime() - ownedPollAt;
        return prepared() && credential.equals(configuration.optString("deviceToken")) && latest != null && "owned".equals(latest.optString("state")) && !latest.optBoolean("offline") && ownedPollAt > 0 && age >= 0 && age <= 60000L;
    }
    public NativeHttp.Reply local() throws Exception {
        final String credential = token();
        NativeHttp.Reply response = http.local(credential, () -> localAllowed(credential));
        if (response.status != 200) return response;
        String sanitized = LocalContent.sanitize(response.text());
        if (!localAllowed(credential)) throw new SecurityException("Local data authorization changed during validation.");
        return new NativeHttp.Reply(200, "application/json", sanitized.getBytes(StandardCharsets.UTF_8));
    }
    public NativeHttp.Reply poll() throws Exception {
        try {
            NativeHttp.Reply response = http.send("/device/v1/poll", "GET", null, token(), 131072);
            if (response.status == 200) {
                JSONObject state = new JSONObject(response.text()); acceptPoll(state, true);
                if ("erase".equals(state.optString("state"))) return post("/device/v1/erase", new JSONObject());
            }
            else if (response.status == 401) {
                if (observer != null) observer.erased(); recover();
                response = http.send("/device/v1/poll", "GET", null, token(), 131072);
                if (response.status == 200) {
                    JSONObject state = new JSONObject(response.text()); acceptPoll(state, true);
                    if ("erase".equals(state.optString("state"))) return post("/device/v1/erase", new JSONObject());
                }
            } else if (response.status == 403) { if (observer != null) observer.erased(); synchronized (this) { denyContent(); latest = null; vault.clearContent(); } }
            return response;
        } catch (java.io.IOException error) {
            synchronized (this) {
                if (configuration.optBoolean("contentDenied") || expiry() == 1) throw error;
                byte[] cached = vault.get("poll");
                if (cached == null) throw error;
                JSONObject record = new JSONObject(new String(cached, StandardCharsets.UTF_8));
                if (!Protocol.active(record.getLong("expiresAt"), record.getLong("fetchedAt"), System.currentTimeMillis())) { clearContent(); throw error; }
                JSONObject state = record.getJSONObject("state"); state.put("offline", true); acceptPoll(state, false);
                return new NativeHttp.Reply(200, "application/json", state.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
    }
    public NativeHttp.Reply media(String path) throws Exception {
        String id = protocol.mediaId(path);
        synchronized (this) { if (id == null || !approvedMedia.contains(id) || expiry() <= System.currentTimeMillis()) throw new SecurityException("Photo is not approved by the current snapshot."); }
        NativeHttp.Reply response;
        try { response = http.send(path, "GET", null, token(), 196608); }
        catch (java.io.IOException error) {
            synchronized (this) {
                if (!approvedMedia.contains(id) || expiry() <= System.currentTimeMillis()) throw error;
                byte[] cached = vault.get(cacheName("photo-", id)); if (cached == null) throw error;
                JSONObject record = new JSONObject(new String(cached, StandardCharsets.UTF_8));
                return new NativeHttp.Reply(200, record.getString("mime"), Base64.decode(record.getString("data"), Base64.DEFAULT));
            }
        }
        if (response.status == 200) {
            byte[] bytes = response.data; String mime = response.mime;
            if ("application/json".equals(mime)) {
                JSONObject data = new JSONObject(response.text()); mime = data.getString("mime"); bytes = Base64.decode(data.getString("data"), Base64.DEFAULT);
            }
            if (!("image/jpeg".equals(mime) || "image/png".equals(mime)) || bytes.length > 98304) throw new SecurityException("Unsupported private photo.");
            android.graphics.BitmapFactory.Options bounds = new android.graphics.BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            if (bounds.outWidth < 1 || bounds.outHeight < 1 || bounds.outWidth > 4096 || bounds.outHeight > 4096 || (long) bounds.outWidth * bounds.outHeight > 8000000L) throw new SecurityException("Private photo dimensions denied.");
            synchronized (this) {
                if (!approvedMedia.contains(id) || expiry() <= System.currentTimeMillis()) throw new SecurityException("Photo approval expired during fetch.");
                vault.put(cacheName("photo-", id), new JSONObject().put("mime", mime).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)).toString().getBytes(StandardCharsets.UTF_8));
            }
            return new NativeHttp.Reply(200, mime, bytes);
        }
        return response;
    }
    public NativeHttp.Reply asset(String path) throws Exception {
        if (!protocol.publicAsset(path)) throw new SecurityException("Public asset denied.");
        NativeHttp.Reply response;
        try { response = http.send(path, "GET", null, null, 1048576); }
        catch (java.io.IOException error) {
            byte[] cached = vault.get(cacheName("asset-", path)); if (cached == null) throw error;
            JSONObject record = new JSONObject(new String(cached, StandardCharsets.UTF_8));
            return new NativeHttp.Reply(200, record.getString("mime"), Base64.decode(record.getString("data"), Base64.DEFAULT));
        }
        if (response.status == 200 && !("text/html".equals(response.mime) || "text/css".equals(response.mime) || "text/javascript".equals(response.mime) || "application/javascript".equals(response.mime))) throw new SecurityException("Unexpected executable asset type.");
        if (response.status == 200) vault.put(cacheName("asset-", path), new JSONObject().put("mime", response.mime).put("data", Base64.encodeToString(response.data, Base64.NO_WRAP)).toString().getBytes(StandardCharsets.UTF_8));
        return response;
    }
    public NativeHttp.Reply post(String path, JSONObject body) throws Exception {
        return post(path, body, 0L, () -> true);
    }
    public NativeHttp.Reply post(String path, JSONObject body, long claimExpiry, java.util.function.BooleanSupplier permitted) throws Exception {
        if (!protocol.devicePost(path)) throw new SecurityException("Native command is outside the device protocol.");
        synchronized (this) {
            if ("/device/v1/confirm".equals(path)) {
                if (latest == null || !"confirm".equals(latest.optString("state")) || body.length() != 1 || !latest.getString("phrase").equals(body.optString("phrase"))) throw new SecurityException("Claim phrase does not match the pending screen claim.");
                if (!hasPin() || !ClaimPolicy.current(latest.optString("state"), latest.optString("phrase"), latest.optLong("expiresAt"), body.optString("phrase"), latest.optLong("expiresAt"), System.currentTimeMillis())) throw new SecurityException("Claim confirmation expired or has no owner PIN.");
            } else if ("/device/v1/ack".equals(path)) {
                if (latest == null || body.length() != 2 || !SnapshotState.hasSnapshot(latest) || body.optLong("revision", -1) != latest.getLong("revision") || !latest.getString("nonce").equals(body.optString("nonce")) || expiry() <= System.currentTimeMillis()) throw new SecurityException("Receipt does not match a live delivered revision.");
            } else if ("/device/v1/voice".equals(path) || "/device/v1/lists".equals(path)) {
                DeviceCommandPolicy.check(path, body);
            } else if (body.length() != 0) throw new SecurityException("Unexpected native command data.");
            if ("/device/v1/erase".equals(path)) {
                if (latest == null || !"erase".equals(latest.optString("state"))) throw new SecurityException("No owner-authorized reset is pending.");
                if (observer != null) observer.erased();
                configuration.put("resetPending", true); save();
                denyContent(); vault.clearContent(); approvedMedia.clear();
            }
        }
        String credentialForRequest = token();
        synchronized (this) {
            if (!permitted.getAsBoolean()) throw new SecurityException("Native command is no longer authorized.");
            if ("/device/v1/confirm".equals(path) && !currentClaim(body.optString("phrase"), claimExpiry == 0L && latest != null ? latest.optLong("expiresAt") : claimExpiry)) throw new SecurityException("Claim expired before HTTP confirmation.");
        }
        NativeHttp.Reply response = http.send(path, "POST", body.toString(), credentialForRequest, 65536);
        if ("/device/v1/erase".equals(path) && response.status == 200) {
            JSONObject rotated = new JSONObject(response.text()); String credential = rotated.getString("deviceToken");
            if (!credential.matches("[A-Za-z0-9_-]{32,256}")) throw new SecurityException("Invalid rotated transport credential.");
            synchronized (this) { configuration.put("deviceToken", credential); configuration.remove("pinSalt"); configuration.remove("pinHash"); configuration.remove("resetPending"); configuration.put("pinFailures", 0); configuration.put("pinBlockedUntil", 0); save(); latest = new JSONObject().put("state", "unclaimed"); }
            if (observer != null) observer.changed(latest);
            return new NativeHttp.Reply(200, "application/json", "{\"state\":\"unclaimed\"}".getBytes(StandardCharsets.UTF_8));
        }
        return response;
    }
    public synchronized void clearContent() throws Exception { denyContent(); latest = null; approvedMedia.clear(); contentDeadline = 0; vault.clearContent(); }
}
