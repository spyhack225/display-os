package com.displayos.kiosk;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

public final class NativeHttp {
    public static final class Reply {
        public final int status; public final String mime; public final byte[] data;
        public Reply(int status, String mime, byte[] data) { this.status = status; this.mime = mime; this.data = data; }
        public String text() { return new String(data, StandardCharsets.UTF_8); }
    }
    private final Protocol protocol;
    interface Connections { HttpsURLConnection open(URL address) throws Exception; }
    private final Connections connections;
    public NativeHttp(Protocol protocol) { this(protocol, address -> (HttpsURLConnection) address.openConnection()); }
    NativeHttp(Protocol protocol, Connections connections) { this.protocol = protocol; this.connections = connections; }
    public Reply local(String token, java.util.function.BooleanSupplier permitted) throws Exception {
        if (token == null || !permitted.getAsBoolean()) throw new SecurityException("Local data requires a current owned screen.");
        Reply reply = send("/device/v1/local", "GET", null, token, 32768, 35000);
        if (!permitted.getAsBoolean()) throw new SecurityException("Local data authorization changed during fetch.");
        if (reply.status != 200) return new Reply(reply.status, "application/json", "{}".getBytes(StandardCharsets.UTF_8));
        if (!"application/json".equals(reply.mime)) throw new SecurityException("Local data must be structured JSON.");
        return reply;
    }
    public Reply send(String path, String method, String body, String token, int maximum) throws Exception {
        return send(path, method, body, token, maximum, 8000);
    }
    Reply send(String path, String method, String body, String token, int maximum, int readTimeout) throws Exception {
        if (readTimeout < 1 || readTimeout > 35000 || readTimeout != 8000 && !("/device/v1/local".equals(path) && "GET".equals(method) && token != null)) throw new IllegalArgumentException("Read timeout is outside the native route budget.");
        if (protocol.path(protocol.origin() + path) == null) throw new SecurityException("Noncanonical request denied.");
        if (token != null && !protocol.bearerAllowed(path, method)) throw new SecurityException("Credential destination denied.");
        HttpsURLConnection connection = connections.open(new URL(protocol.origin() + path));
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(8000); connection.setReadTimeout(readTimeout); connection.setRequestMethod(method); connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (body != null) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 65536) throw new IllegalArgumentException("Request exceeds contract bound.");
                connection.setRequestProperty("Content-Type", "application/json"); connection.setDoOutput(true); connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new SecurityException("Redirects are forbidden.");
            String type = connection.getContentType(); String mime = type == null ? "application/octet-stream" : type.split(";")[0].trim();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream result = new ByteArrayOutputStream();
            if (stream != null) try (InputStream input = stream) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) { if (result.size() + count > maximum) throw new IllegalArgumentException("Response exceeds bound."); result.write(buffer, 0, count); }
            }
            return new Reply(status, mime, result.toByteArray());
        } finally { connection.disconnect(); }
    }
}
